#!/usr/bin/env node
import { detectClips, ClipDetector, parseClipCommand, scoreLine, CLIP_CATEGORIES } from "../js/clip-detector.js";
const ok = (c, m) => { if (!c) throw new Error("FAILED: " + m); console.log("  ok — " + m); };
const L = (t, speaker, text, end) => ({ t, speaker, text, ...(end != null ? { end } : {}) });

console.log("\n\"Moxie, clip that\" command");
{
  for (const t of ["Moxie, clip that", "hey Moxie clip that", "Hey Moxie, please clip that.", "Okay Moxie: clip this", "clip that, Moxie", "So that was great. Moxie, clip that!"]) ok(parseClipCommand(t), `recognised: "${t}"`);
  for (const t of ["Moxie is a great name", "I need to clip that cable", "clip that", "Moxie, play the drum roll", "we should clip that part later"]) ok(!parseClipCommand(t), `ignored: "${t}"`);
  ok(parseClipCommand("Moxie, clip that last 45 seconds").lookbackSeconds === 45, "optional lookback is parsed (last 45 seconds)");
  ok(parseClipCommand("Moxie clip that last 2 minutes").lookbackSeconds === 120, "minutes are converted");
}

console.log("\nLine scoring");
{
  ok(scoreLine(L(1, "A", "Honestly I think that is the worst advice anyone has ever given about hiring.")).category === "strong-opinion", "strong opinion");
  ok(scoreLine(L(1, "A", "Here's the thing: the reason it fails is because nobody owns the follow up.")).category === "insight", "insight");
  ok(scoreLine(L(1, "A", "Wait, no way, you're kidding?!")).category === "surprise", "surprise");
  ok(scoreLine(L(1, "A", "I was terrified, my dad passed away that year and I miss him.")).category === "emotional", "emotional");
  ok(scoreLine(L(1, "A", "okay")).score === 0, "filler scores nothing");
  ok(scoreLine(L(1, "A", "Let me finish my point—", 4), null, L(3, "B", "No, stop.")).category === "interruption", "interruption (cut off, other speaker starts early)");
}

console.log("\nBatch detection on a realistic conversation");
{
  const lines = [
    L(0, "Host", "Welcome back to the show, today we are talking about hiring."),
    L(6, "Guest", "Thanks for having me, glad to be here."),
    L(12, "Host", "Let's start simple. What do most founders get wrong?"),
    L(18, "Guest", "Honestly, I think the biggest mistake is hiring for résumé instead of curiosity."),
    L(26, "Guest", "Here's the thing: the reason it fails is because nobody on the team owns the follow up, so great candidates just disappear."),
    L(40, "Host", "Wait, no way, you are kidding. That actually happened to you?!"),
    L(46, "Guest", "Ha ha ha, yes! We lost a brilliant engineer because of a calendar invite."),
    L(70, "Host", "Okay."),
    L(80, "Host", "So um, what about interns?"),
    L(86, "Guest", "I disagree with how people treat interns, that is just wrong."),
    L(92, "Host", "But that's not true for every company, come on."),
    L(99, "Guest", "No, no, no — that is exactly the problem, and you know it."),
    L(150, "Host", "Thank you so much for being here, I mean it."),
  ];
  const events = [{ type: "laughter", t: 47, end: 51 }];
  const clips = detectClips({ lines, events, duration: 160, minScore: 45 });
  console.log("  " + clips.map((c) => `[${c.start}-${c.end}s ${c.category} ${c.score}] ${c.title}`).join("\n  "));
  ok(clips.length >= 3, `finds several distinct moments (${clips.length})`);
  const around = (t) => clips.find((c) => c.start <= t && c.end >= t);
  ok(around(18) && around(26), "the strong opinion and insight are bookmarked");
  const surprise = around(40);
  ok(surprise && surprise.end >= 51, "the surprise clip includes the laughter that follows (reaction captured)");
  ok(surprise.start <= 30, `and the build-up before it (starts ${surprise.start}s)`);
  ok(around(92) && ["argument", "strong-opinion"].includes(around(92).category), "the disagreement is bookmarked");
  ok(clips.every((c) => c.end - c.start >= 10 && c.end - c.start <= 75), "every clip is between 10 and 75 seconds");
  ok(clips.every((c) => c.title && c.reason && c.score >= 45 && CLIP_CATEGORIES[c.category]), "every clip has a title, category, score and a reason");
  ok(clips.every((c, i) => i === 0 || c.start >= clips[i - 1].start) && clips.every((c, i) => i === 0 || c.start >= clips[i - 1].end - 0.001), "clips are in time order and do not overlap");
  ok(!detectClips({ lines: [L(0, "A", "Hello."), L(5, "B", "Hi there, how are you today.")], duration: 30 }).length, "small talk produces no clips");
}

console.log("\nAwkward silence, nervous laughter, banter, group laughter");
{
  const silence = detectClips({ lines: [L(0, "A", "So are you going to answer the question about the budget?"), L(11, "B", "Um, I guess, well...")], events: [{ type: "laughter", t: 11.5, end: 13 }], duration: 40, minScore: 40 });
  ok(silence.some((c) => c.category === "nervous-laughter"), "a long pause broken by nervous laughter");
  const banter = detectClips({ lines: [L(0, "A", "You first."), L(1.5, "B", "No way, you."), L(3, "A", "Rock paper scissors?"), L(4.5, "B", "Fine, ha ha."), L(6, "A", "Best of three."), L(7.5, "B", "Obviously.")], duration: 30, minScore: 40 });
  ok(banter.some((c) => c.category === "banter"), "fast alternating turns are banter");
  const laugh = detectClips({ lines: [L(0, "A", "And that is why I never lend my brother my car again.")], events: [{ type: "laughter", t: 4, end: 8 }, { type: "laughter", t: 9, end: 11 }], duration: 30, minScore: 40 });
  ok(laugh.some((c) => c.category === "laughter" && c.end >= 11), "group laughter after a line, covering the whole reaction");
}

console.log("\nLive: rolling window, automatic bookmarks and \"clip that\"");
{
  const seen = [], closed = [];
  const d = new ClipDetector({ onBookmark: (b, i) => seen.push({ ...b, open: i.open }), onClose: (b) => closed.push(b) });
  d.addTranscript(L(6, "Host", "Welcome everyone, today is about hiring."));
  d.addTranscript(L(10, "Guest", "Honestly I think the biggest mistake is hiring for résumé instead of curiosity."));
  d.addTranscript(L(18, "Guest", "Here's the thing: the reason it fails is because nobody owns the follow up."));
  d.tick(20);
  ok(seen.length === 0, "nothing is bookmarked while the moment is still unfolding");
  const t1 = d.tick(32);
  ok(t1.fresh.length === 1 && t1.fresh[0].start <= 10 && t1.fresh[0].end >= 18, `the moment is bookmarked once it settles (${t1.fresh[0]?.start}-${t1.fresh[0]?.end}s)`);
  ok(d.tick(36).fresh.length === 0, "and is not bookmarked twice");

  d.addTranscript(L(60, "Guest", "We tried the old process for three years and it never worked."));
  d.addTranscript(L(66, "Guest", "That changed everything for us, we finally shipped on time."));
  const cmd = d.addTranscript(L(72, "Host", "Moxie, clip that"));
  ok(cmd && cmd.open && cmd.source === "command" && cmd.category === "clip-that", "the spoken command opens a bookmark");
  ok(cmd.start < 62 && cmd.start >= 40, `it reaches back to include the preceding context (starts ${cmd.start}s, command at 72s)`);
  ok(/old process|changed everything/i.test(cmd.title), `titled from what was said (“${cmd.title}”)`);
  d.addTranscript(L(75, "Guest", "And yes, we are still using that approach today."));
  d.tick(77);
  ok(d.open.length === 1, "capture continues while people are still talking");
  const t2 = d.tick(84);
  ok(t2.closed.length === 1 && !t2.closed[0].open && t2.closed[0].end >= 78 && t2.closed[0].end <= 84, `it closes once the moment concludes (ends ${t2.closed[0]?.end}s)`);
  const never = new ClipDetector();
  never.addTranscript(L(0, "A", "Moxie, clip that"));
  never.tick(200);
  ok(never.bookmarks[0].end - never.bookmarks[0].start <= 90 && !never.open.length, "an open clip is capped at 90 seconds");
  ok(d.finish(90).length >= 2, "finish() returns everything bookmarked, sorted");
}
console.log("ALL PASSED — Moxie clip detection finds, widens and bookmarks moments, live and in batch.");
