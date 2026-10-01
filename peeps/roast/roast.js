const API_BASE = location.hostname === "toasty.media" || location.hostname === "www.toasty.media"
  ? "https://render.toasty.media"
  : "http://127.0.0.1:4174";

const $ = (s) => document.querySelector(s);
const form = $("#roastForm");
const pitch = $("#pitch");
const status = $("#status");
const result = $("#result");
const button = $("#roastButton");
const count = $("#count");
const deckFile = $("#deckFile");
const deckStatus = $("#deckStatus");
const MAX_DECK_BYTES = 15 * 1024 * 1024;
const MAX_DECK_TEXT = 18000;
let extractedDeckText = "";

pitch.addEventListener("input", () => { count.textContent = `${pitch.value.length.toLocaleString()} / 12,000`; });

function text(id, value) { $(id).textContent = String(value || ""); }

function normalizeDeckText(value) {
  return String(value || "")
    .replace(/\u0000/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, MAX_DECK_TEXT);
}

async function extractPdf(file) {
  const pdfjsLib = await import("https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.min.mjs");
  pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.worker.min.mjs";
  const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
  const pages = [];
  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const content = await page.getTextContent();
    const pageText = content.items.map((item) => item.str || "").join(" ").trim();
    if (pageText) pages.push(`[Slide/Page ${pageNumber}]\n${pageText}`);
    if (pages.join("\n\n").length >= MAX_DECK_TEXT) break;
  }
  return normalizeDeckText(pages.join("\n\n"));
}

function xmlText(xml) {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  if (doc.querySelector("parsererror")) return "";
  return [...doc.getElementsByTagName("*")]
    .filter((node) => /(^|:)t$/.test(node.tagName))
    .map((node) => node.textContent || "")
    .join(" ")
    .trim();
}

async function extractPptx(file) {
  const { default: JSZip } = await import("https://cdn.jsdelivr.net/npm/jszip@3.10.1/+esm");
  const zip = await JSZip.loadAsync(await file.arrayBuffer());
  const slidePaths = Object.keys(zip.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((a, b) => Number(a.match(/slide(\d+)/)?.[1] || 0) - Number(b.match(/slide(\d+)/)?.[1] || 0));
  const slides = [];
  for (let i = 0; i < slidePaths.length; i += 1) {
    const xml = await zip.file(slidePaths[i]).async("text");
    const slideText = xmlText(xml);
    if (slideText) slides.push(`[Slide ${i + 1}]\n${slideText}`);
    if (slides.join("\n\n").length >= MAX_DECK_TEXT) break;
  }
  return normalizeDeckText(slides.join("\n\n"));
}

async function extractDeck(file) {
  const name = file.name.toLowerCase();
  if (file.size > MAX_DECK_BYTES) throw new Error("Deck is too large. Maximum is 15 MB.");
  if (name.endsWith(".pdf")) return extractPdf(file);
  if (name.endsWith(".pptx")) return extractPptx(file);
  if (name.endsWith(".txt")) return normalizeDeckText(await file.text());
  throw new Error("Use a PDF, PPTX or TXT deck.");
}

deckFile.addEventListener("change", async () => {
  extractedDeckText = "";
  const file = deckFile.files?.[0];
  if (!file) {
    deckStatus.textContent = "PDF, PPTX or TXT · extracted in your browser · max 15 MB";
    return;
  }
  deckStatus.textContent = `Reading ${file.name}…`;
  deckFile.disabled = true;
  try {
    extractedDeckText = await extractDeck(file);
    if (!extractedDeckText) throw new Error("I couldn't find readable text in that deck.");
    deckStatus.textContent = `${file.name} · ${extractedDeckText.length.toLocaleString()} characters extracted locally`;
  } catch (error) {
    deckFile.value = "";
    deckStatus.textContent = error.message || "Couldn't read that deck.";
  } finally {
    deckFile.disabled = false;
  }
});

function render(data) {
  text("#opening", data.opening);
  text("#understand", data.understand);
  text("#strongestProof", data.strongestProof);
  text("#redFlag", data.redFlag);
  text("#cut", data.cut);
  text("#rewrite", data.rewrite);
  text("#judgeQuestion", data.judgeQuestion);
  const changes = Array.isArray(data.changes) ? data.changes.slice(0, 3) : [];
  $("#changes").innerHTML = "";
  for (const change of changes) {
    const li = document.createElement("li");
    li.textContent = change;
    $("#changes").appendChild(li);
  }
  result.hidden = false;
  result.scrollIntoView({ behavior: "smooth", block: "start" });
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const blurb = pitch.value.trim();
  if (!blurb && !extractedDeckText) {
    status.textContent = "Upload a deck or paste your pitch first.";
    return;
  }
  const combinedPitch = [
    extractedDeckText ? "DECK TEXT:\n" + extractedDeckText : "",
    blurb ? "FOUNDER BLURB / SPOKEN PITCH:\n" + blurb : ""
  ].filter(Boolean).join("\n\n").slice(0, 24000);
  const body = {
    startup: $("#startup").value.trim(),
    oneLiner: $("#oneLiner").value.trim(),
    pitch: combinedPitch
  };
  status.textContent = "";
  button.disabled = true;
  button.textContent = "Roasting…";
  try {
    const response = await fetch(`${API_BASE}/api/peeps/josip-roast`, {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json", "x-toasty-csrf": "1" },
      body: JSON.stringify(body)
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || data.message || "Roast failed.");
    render(data);
  } catch (error) {
    status.textContent = error.message || "Roast failed.";
  } finally {
    button.disabled = false;
    button.textContent = "Roast my pitch";
  }
});

$("#copyRoast").addEventListener("click", async () => {
  const blocks = [
    $("#opening").textContent,
    "I DON'T UNDERSTAND\n" + $("#understand").textContent,
    "YOUR STRONGEST PROOF\n" + $("#strongestProof").textContent,
    "RED FLAG\n" + $("#redFlag").textContent,
    "CUT\n" + $("#cut").textContent,
    "REWRITE THE ONE-LINER\n" + $("#rewrite").textContent,
    "THE QUESTION A JUDGE WILL ASK\n" + $("#judgeQuestion").textContent,
    "FIX BEFORE YOU PITCH AGAIN\n" + [...$("#changes").children].map((li, i) => `${i + 1}. ${li.textContent}`).join("\n")
  ];
  await navigator.clipboard.writeText(blocks.join("\n\n"));
  $("#copyRoast").textContent = "Copied";
  setTimeout(() => { $("#copyRoast").textContent = "Copy"; }, 1200);
});