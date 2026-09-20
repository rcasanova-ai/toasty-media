# Missing catalogue asset: Cholo Whistle

## Status

**NOT SHIPPED.** Slot id `cholo-whistle-01` is reserved in `catalogue.json` with `"missing": true`. Program Audio will not play it. No file is bundled.

## What the sound is

The Mexican/Chicano “cholo whistle” is a street greeting and alert used in Chicano / Mexican-American neighborhoods. It is typically a short, two-phrase finger or lip whistle used to get a friend’s attention across a street or lot. It is **not**:

- the two-tone wolf / catcall whistle (`File:Wolf whistle.ogg`)
- a steam / camote vendor whistle
- a generic “exotic whistle” sample
- a synthesized oscillator recreation

The previously shipped pad labeled “Cholo Whistle” was the Commons wolf whistle. That recording remains in the catalogue as **`wolf-whistle-01` / Wolf Whistle**.

## Search performed (2026-09-20)

Looked for a redistribution-safe recording (CC0, public domain, or similarly compatible) of the actual Chicano street whistle:

- Wikimedia Commons: no file identified as a Chicano/Cholo street whistle. `File:Wolf whistle.ogg` is a wolf/catcall and is now catalogued under that name.
- Freesound: no CC0/CC-BY recording documented as this cultural street whistle. Generic wolf-whistle and sports-crowd whistles are the wrong sound.

No legally redistributable recording was found. Per production policy, this run does **not** fake one.

## Path to add it later

1. Commission or obtain a real recording from a Chicano/Mexican-American performer who consents to redistribution.
2. Prefer CC0 or an explicit license that allows bundling in Toasty’s catalogue (`assets/catalogue/audio/`).
3. Document creator, license, license URL, and source URL in `catalogue.json`.
4. Loudnorm to the catalogue standard (`scripts/prepare-catalogue-audio.sh`).
5. Keep id `cholo-whistle-01`. Do not alias it to `wolf-whistle-01`.
