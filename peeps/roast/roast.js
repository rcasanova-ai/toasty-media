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

pitch.addEventListener("input", () => { count.textContent = `${pitch.value.length.toLocaleString()} / 12,000`; });

function text(id, value) { $(id).textContent = String(value || ""); }

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
  const body = {
    startup: $("#startup").value.trim(),
    oneLiner: $("#oneLiner").value.trim(),
    pitch: pitch.value.trim()
  };
  if (!body.pitch) return;
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