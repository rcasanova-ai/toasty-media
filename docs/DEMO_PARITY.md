# Demo versus production parity

The scripted demo (`/peeps/demo/`) and the real-services path (`/peeps/app/golden-path.html`) tell one story. Status of each target step, verified in a browser against the local sandbox unless noted.

| # | Target step | Demo | Production path | Parity |
|---|---|---|---|---|
| 1 | Requester describes the outcome | one box | two boxes (who, outcome) | Equivalent |
| 2 | Agent discovers candidates | seeded pool | real ranking (history, network Dubs, labelled directory) | Real |
| 3 | Agent interviews candidate Dubs | scripted Dub interview (David excluded, Sarah asks her human) | **Dub evidence interview**: each request criterion becomes a question; a candidate's Dub answers only by quoting its own stored, approved claims, else "Unknown". Candidates without Dub content get a directory evidence match, labelled as not a Dub interview. Persisted. Deterministic, no LLM, no live A2A conversation | Real, evidence-based (not conversational) |
| 4 | Agent evaluates evidence | scripted, with exclusion reasons | persisted verdict (qualified / excluded), coverage score, exclusion explanation naming the unevidenced criteria, ranking | Real |
| 5 | Requester authorizes | click | click, with Dough or verified Solana USDC | Real |
| 6 | Candidate accepts | scripted | real private guest page | Real |
| 7 | Jam booked | scripted | automatic first mutual slot | Real |
| 8 | Participants join Studio | simulated room | real room; **needs the live-device test** | Unverified live |
| 9 | Consent captured | simulated | real, from the participant | Real |
| 10 | Recording finalized | simulated | automatic registration on real Studio finalization (tested with a real WebM); live recording unverified | Partial |
| 11 | Transcript provided | scripted | automatic transcript from the finalized recording when whisper is configured (labelled unattributed; no person-specific Breadcrumbs from it), plus a requester upload with speakers (sample text button, labelled) | Partial |
| 12 | Breadcrumbs generated | scripted | real, from attributed transcript segments | Real |
| 13 | Dough updates | simulated ledger | real ledger | Real |
| 14 | Solana / Zcash evidence | labelled demo | real devnet verification; real regtest shielded settlement | Real (devnet / regtest) |
| 15 | Final receipt | results screen | receipt labelling on-chain / off-chain / simulated / pending | Real |

Counting Real as 1, Partial/Unverified as 0.5 and Gap as 0: about 87% (13 of 15). The remaining differences are the non-conversational nature of the evidence interview (no live Dub-to-Dub conversation), speaker-attributed transcripts being manual, and live-device Studio verification.