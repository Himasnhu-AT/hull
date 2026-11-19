# Ironleaf

A third-person samurai action game on a windswept island. You are a lone swordswoman. Every enemy shows you what it is about to do; you read it and answer with your blade.

Ironleaf is an original game: its heroine, island, factions, art and sound are its own. This file is the design. Phase 1 (done) built the island, the people, the sound and the effects with a placeholder swing. Phase 2 turns the tables below into `move-set` and `enemy` configs on the combat kit.

## 1. Premise

**Hoshiro** is a province on a small island at the edge of the map: pampas fields on the western plain, bamboo groves, a hill village (**Kitsugi**) on a plateau, and a shrine on the hill above it. The **Ashfall Band**, raiders who burn what they cannot carry, have landed. **Aya** of the Sedge Hall carries the island's one blade of ironleaf steel, forged with a pattern of veins like a leaf. Her order's rule is to answer, not to attack: you do not strike first at someone who has not drawn.

Story beats (phase 3 writes the lines):

1. Aya lands on the west beach at dusk and walks the road through the pampas.
2. The raider camp in the field: five of the Band, a fire, a stolen cart. She can stand off or fight.
3. The gate of Kitsugi: a brute holds it.
4. An archer watches the village road from the rocks.
5. The shrine stairs: **Kagari**, the Band's duelist, waits to duel.

## 2. Pillars

1. **Read and answer.** Every enemy attack is telegraphed by a pose and a short glint on the blade. Blockable attacks can be blocked or deflected. A perfect deflect (a tight window just before impact) staggers the enemy and drains its posture. A red flash means unblockable: dodge it.
2. **Stances.** Three stances, each a move-set with light and heavy strings and a charged heavy that breaks guard. The right stance deals more posture damage.
3. **Posture.** Blocks, deflects and heavy hits fill the enemy's posture. A broken posture opens a finishing strike. Aya has posture too.
4. **Standoff.** A fight may start with a standoff: hold, release on the enemy's twitch for an instant kill. Misread and take a hit.
5. **Duels.** The boss duel has phases and a readable but varied pattern set.

## 3. Controls

| Action | Keyboard and mouse | Pad | Input name |
|---|---|---|---|
| Move | W A S D | left stick | `move` |
| Look | mouse | right stick, arrow keys | `look`, `lookPad` |
| Sprint | Left Shift | left stick press | `sprint` |
| Dodge | Space | east | `dodge` |
| Light attack | left click, F | west | `attack` |
| Heavy attack (hold to charge) | right click, R | right trigger | `heavy` |
| Block (hold), deflect (tap just before impact) | Q | left trigger | `block` |
| Change stance | Tab, C | north | `stance` |
| Lock on | T, middle click | right stick press | `lockOn` |
| Change the look (dusk, rain, night) | L | back | `looks` |
| Pause | Esc, P | start | `pause` |

Phase 1 uses move, look, sprint, attack (a placeholder swing: one cut in front, 40 damage), looks and pause.

## 4. Stances

| Stance | Strong against | Feel | Light string | Heavy | Charged heavy |
|---|---|---|---|---|---|
| **Stone** | swords | Planted, one step per cut, wide guard | 3 cuts: down-right, up-left, straight down | one overhead | steps in, breaks guard, 2.0x posture |
| **Water** | spears | Flowing, slides along the spear shaft | 4 quick cuts alternating, ends with a low sweep | a rising cut | spinning slash, hits all around, breaks guard |
| **Wind** | brutes | Light, circles and cuts the legs | 2 cuts then a back-step | a lunge | a leap cut over the head, breaks guard |

Posture damage multiplier: the right stance against its enemy 1.5x, a neutral match 1.0x, the wrong stance 0.7x. Changing stance takes 0.25 s and can cancel the end of a string.

## 5. Move-set data (for phase 2)

Times in seconds from the start of the clip. `startup` is input to the first frame the blade can hit; `active` is the window in which the blade trace is live; `recover` is the end of the move; `cancel` is from when the next input is taken. Damage is health; posture is posture damage on an unguarded hit (a blocked hit does 60% of it to the enemy, a deflect 120%). Reach is from the katana base along the blade, in metres. Input to swing start must stay under 0.1 s.

| Move | Stance | Input | Clip | Startup | Active | Recover | Cancel from | Damage | Posture | Reach | Cancels into |
|---|---|---|---|---|---|---|---|---|---|---|---|
| stone-1 | Stone | light | slash-a | 0.09 | 0.09-0.20 | 0.46 | 0.30 | 18 | 14 | 1.1 | stone-2, dodge |
| stone-2 | Stone | light after stone-1 | slash-b | 0.09 | 0.09-0.19 | 0.44 | 0.30 | 18 | 14 | 1.1 | stone-3, dodge |
| stone-3 | Stone | light after stone-2 | heavy | 0.20 | 0.30-0.42 | 0.80 | 0.58 | 30 | 24 | 1.2 | dodge |
| stone-heavy | Stone | heavy | heavy | 0.30 | 0.32-0.46 | 0.85 | 0.64 | 34 | 30 | 1.2 | dodge |
| stone-charge | Stone | heavy held 0.6 s | heavy | 0.60 | 0.62-0.78 | 1.10 | 0.90 | 40 | 48 | 1.3 | none |
| water-1..4 | Water | light x4 | slash-a, slash-b (alternating) | 0.08 | 0.08-0.17 | 0.40 | 0.26 | 12 | 10 | 1.1 | next string, dodge |
| water-heavy | Water | heavy | slash-b | 0.22 | 0.22-0.34 | 0.70 | 0.50 | 26 | 22 | 1.1 | dodge |
| water-charge | Water | heavy held 0.6 s | slash-a | 0.55 | 0.55-0.80 | 1.0 | 0.85 | 30 | 44 | 1.4 (all around) | none |
| wind-1..2 | Wind | light x2 | slash-a, slash-b | 0.07 | 0.07-0.16 | 0.36 | 0.24 | 11 | 9 | 1.0 | next string, back-step |
| wind-heavy | Wind | heavy | slash-a | 0.18 | 0.18-0.30 | 0.60 | 0.44 | 24 | 20 | 1.4 | dodge |
| wind-charge | Wind | heavy held 0.6 s | heavy | 0.50 | 0.52-0.70 | 1.0 | 0.82 | 30 | 44 | 1.3 | none |
| block | any | block held | block | 0.12 | hold | 0.12 | any | 0 | 0 | 0 | all |
| deflect | any | block tap in the window | deflect | 0.03 | 0.00-0.12 before impact | 0.34 | 0.22 | 0 | 40 on the enemy | 0 | all |
| dodge | any | dodge | dodge | 0.04 | i-frames 0.05-0.30 | 0.50 | 0.36 | 0 | 0 | 0 | attacks after 0.36 |
| finisher | any | attack on a posture-broken enemy within 2 m | heavy | 0.30 | 0.32-0.46 | 1.1 | none | kills a raider, 35% of a boss bar | 0 | 1.5 | none |

Clip names (phase 2, `config/anim-set/aya.json`): every move plays the clip of its own name (`stone-1`, `water-4`, `wind-charge`, ...; the Clip column above is the phase-1 name), plus `finisher-stone`, `finisher-water`, `finisher-wind`, `riposte` (after a perfect deflect: trace 0.12-0.24, length 0.6), `draw`, `sheathe`, `quickdraw` (standoff release: trace 0.12-0.22, length 0.5), `deflect`, `block`, `roll`, `dodge-l`, `dodge-r`, `dodge-back`, `hit-light`, `hit-heavy`, `guard-broken`, `stagger` (posture broken, 1.0 s) and `broken` (loop), `death`, and per stance `idle-*`, `hold-*`, `guard-*`. Each strike arrives a few hundredths of a second before its trace window ends and stays out, so the blade is where it is drawn for the whole window. The clips carry their travel in the hips (a move's lunge is that distance). The raiders' attack clips (`raider.json`) match the `raider-*` move-sets. Authoring: `examples/ironleaf/tools` (`pnpm tsx examples/ironleaf/tools/build-anims.ts` re-solves every clip from its key poses).

Rules:

- **Deflect window**: a tap of `block` counts as a perfect deflect when it lands 0.00 to 0.12 s before an enemy blade hits (a blockable attack). Later, holding block is a plain block.
- **Block**: reduces damage to 15%, adds 25% of the attack's posture damage to Aya's posture. A guard break (a charged heavy from an enemy) ignores a block.
- **Aya's posture**: 100. Regenerates 18 per second after 1.2 s out of combat, 8 per second in combat. At 0 she is staggered for 1.0 s.
- **Aya's health**: 100. No healing items in the first levels; a flask at each shrine.
- **Hit-stop**: 40 to 90 ms on a clean hit (light 40, heavy 70, charged 90, finisher 90); none on a blocked hit.
- **Blade trace**: the blade is the line from socket `katanaBase` to `katanaTip` swept between fixed steps against the enemy's hit shapes. A hit needs the trace to touch a shape: no hits from 2 m away.

## 6. Enemies and their patterns (for phase 2)

Posture is the amount of posture damage to break. Weak stance is the one that deals 1.5x posture against it. A **pattern** is a weighted sequence of moves; telegraph is the time between the first pose change and the first hit frame (and the glint). Conditions are checked when the enemy picks its next pattern. Only 1 enemy attacks at a time (2 if the group has 5 or more); the others circle at 3 to 5 metres.

| Enemy | Config | Height | Health | Posture | Weak stance | Speed (walk/run m/s) | Role |
|---|---|---|---|---|---|---|---|
| **Ashblade** (swordsman) | `ashblade` | 1.74 | 80 | 60 | **Stone** | 1.6 / 4.8 | Fast strings, feints |
| **Ashpike** (spearman) | `ashpike` | 1.82 | 90 | 70 | **Water** | 1.4 / 4.2 | Long thrusts, sweeps |
| **Cinder Hulk** (brute) | `hulk` | 2.15 | 240 | 160 | **Wind** | 1.2 / 3.4 | Slow, heavy, grabs, unblockables |
| **Ashkite** (archer) | `ashkite` | 1.70 | 60 | 40 | any (low posture) | 1.8 / 5.0 | Keeps 10 to 16 m away |
| **Kagari** (duelist, boss) | `kagari` | 1.86 | 400 | 200 | none (changes by phase) | 1.8 / 5.4 | Duel with phases |

### Ashblade

| Pattern | Weight | Moves | Telegraph | Damage | Posture | Blockable | Condition |
|---|---|---|---|---|---|---|---|
| single-cut | 4 | sword-cut | 0.35 s, blade lifted overhead, glint at the tip | 14 | 12 | yes | distance under 2.2 |
| cross-cut | 3 | sword-cut, sword-cross | 0.35 s, then a 0.25 s pause | 12 + 12 | 10 + 10 | yes | distance under 2.2 |
| feint-cut | 2 | sword-cut (cancelled at 0.20), then sword-cross | 0.30 s, pose changes mid-way | 16 | 12 | yes | health under 70% |
| dash-in | 2 | run to 1.8 m, then single-cut | 0.45 s | 14 | 12 | yes | distance over 4 |

### Ashpike

| Pattern | Weight | Moves | Telegraph | Damage | Posture | Blockable | Condition |
|---|---|---|---|---|---|---|---|
| thrust | 5 | spear-thrust | 0.45 s, spear drawn back, glint on the head | 16 | 14 | yes | distance 2 to 3.2 |
| double-thrust | 2 | spear-thrust twice, 0.5 s apart | 0.45 s | 14 + 14 | 12 + 12 | yes | health under 60% |
| sweep | 3 | spear-sweep | 0.55 s, spear swung to the side first | 14 | 18 | yes (low: jump or dodge) | distance 1.5 to 2.6 |
| keep-away | 1 | back-step 2 m, then thrust | 0.4 s | 16 | 14 | yes | distance under 1.5 |

### Cinder Hulk

| Pattern | Weight | Moves | Telegraph | Damage | Posture | Blockable | Condition |
|---|---|---|---|---|---|---|---|
| smash | 4 | hulk-smash | 0.8 s, club overhead, grunt | 34 | 40 | yes (guard break) | distance under 2.8 |
| grab | 2 | hulk-grab | 0.6 s, arms spread, **red flash** | 28 | 20 | **no: dodge** | distance under 2.0 |
| stomp-smash | 1 | step, hulk-smash | 0.9 s | 40 | 48 | yes (guard break) | health under 50% |

### Ashkite

| Pattern | Weight | Moves | Telegraph | Damage | Posture | Blockable | Condition |
|---|---|---|---|---|---|---|---|
| shoot | 5 | bow-shoot | 0.7 s, bow drawn, arrow glint, a red line to Aya | 12 | 8 | deflect sends it back | distance 8 to 18 |
| retreat | 3 | run away to 12 m | none | - | - | - | distance under 6 |
| volley | 1 | bow-shoot twice | 0.7 s | 12 + 12 | 8 + 8 | yes | health under 50% |

### Kagari (duel, 3 phases)

Phase changes at 66% and 33% health. A duel starts with a standoff.

| Pattern | Phase | Weight | Moves | Telegraph | Damage | Posture | Blockable | Condition |
|---|---|---|---|---|---|---|---|---|
| cut | 1, 2, 3 | 4 | duel-cut | 0.30 s, glint | 16 | 14 | yes | distance under 2.4 |
| cut-thrust | 1, 2, 3 | 3 | duel-cut, duel-thrust | 0.30 s + 0.35 s | 14 + 20 | 12 + 16 | yes | distance under 2.6 |
| sweep | 2, 3 | 3 | duel-sweep | 0.45 s | 18 | 20 | yes (low) | distance under 2.4 |
| rush | 2, 3 | 2 | dash 5 m, then cut-thrust | 0.5 s, **red flash** on the thrust | 22 | 20 | thrust is **unblockable** | distance over 5 |
| triple | 3 | 2 | duel-cut, duel-thrust, duel-sweep | 0.30 s each, 0.15 s apart | 14 + 18 + 16 | 12 + 14 + 18 | yes | health under 33% |
| reset | 1, 2, 3 | 1 | back-step to 4 m, stance | none | - | - | - | after 3 patterns in a row |

Kagari reads the player's stance and answers it: after a Stone string she opens with a sweep, after Water with a rush, after Wind with a cut-thrust. A perfect deflect against her cut staggers her and drains 40 posture.

### Group rules

- One attack token per group; a second at 5 or more enemies. A token is held from the start of the telegraph to the end of the recovery.
- Archers never take a token for a shot while another enemy is within 4 m of Aya.
- Non-attackers circle at 3 to 5 m, clockwise or counter-clockwise by a per-enemy coin flip from `world.random('ai')`.

## 7. Levels

| Level | Place | Enemies | Look | Goal |
|---|---|---|---|---|
| 1. The Pampas Road | west beach to the camp | 3 Ashblade, 2 Ashpike | dusk | clear the camp (or pass it) |
| 2. Kitsugi Gate | torii at the village foot | Cinder Hulk | dusk | break the gate |
| 3. Rain on the Road | village road, rock above | Ashkite, 2 Ashblade | rain | reach the plaza |
| 4. The Shrine Stairs | stairs and shrine | Kagari | night | win the duel |

Hoshiro itself (phase 1, built): a 300 m square island, an elliptical coast about 100 by 90 m, a plateau at 6.4 m for the village, a 16 m hill for the shrine, three bamboo groves, four pampas fields, 90 cedars, 22 maples, 70 rocks, paths linking landing, camp, gate, village, shrine and groves.

`?start=landing|camp|gate|village|shrine` in the game's URL starts at that place (for testers and screenshots). `?look=dusk|rain|night` starts in that look.

## 8. Feel targets

- Input to swing start under 100 ms.
- Hit-stop 40 to 90 ms on clean hits.
- Blades trace where they are drawn: no hits from 2 m away.
- A clear sound and a spark on every clash; a ring and a flash on a deflect; a deep boom on a perfect deflect.
- 60 frames a second on the Studio's default quality at 1080p.

## 9. Art direction

Warm, low-poly, flat-shaded and lit by the sky: simple big shapes with vertex colour, no textures. Three looks:

- **Golden dusk**: a low honey-coloured sun, long shadows over the straw-gold pampas, a peach haze. The default.
- **Grey rain**: flat cool light, thick haze, rain streaks, wind harder, colours drained.
- **Moonlit night**: blue shadow, a pale moon, fireflies, warm window and lantern light as the only warm colour.

Palette: pampas straw (#c8a65a), cedar green (#2c4a2b), maple red (#c4552b), plaster (#d9cfb8), lacquer red (#a6261d), ironleaf blue-grey (#243352 and #aab2bb). Aya wears ivory, indigo and a red sash and scarf. The Ashfall Band wear charcoal, rust and grey bandage, with iron half-masks and straw hats; Kagari is in crimson with a white lacquer mask. Characters are rigid-part bodies built from boxes, limbs and spheres (the Studio's character recipe): readable silhouettes first.

## 10. Sound direction

Sparse and physical. Silence is allowed. Ambience per look: sea and cicadas at dusk, strong wind and rain in the rain, frogs, crickets and sea at night; wind always. Footsteps change with the ground (grass, dirt, sand, stone, boards, mud in the rain). Swing sounds differ by weight (light, heavy, charged). Clash is bright steel with a hard tick; deflect is a clean ring that hangs; perfect deflect adds a deep boom and a second ring. Music is stingers only, on a pentatonic plucked-string scale with taiko hits: fight start, duel called, victory. No constant score.

| Sound | File |
|---|---|
| draw, sheathe | `sound/sword/draw`, `sound/sword/sheathe` |
| swings | `sound/swing/light`, `heavy`, `charged` |
| clash, deflect, perfect deflect | `sound/clash`, `sound/deflect`, `sound/perfect-deflect` |
| hits | `sound/hit/flesh`, `sound/hit/block` |
| steps | `sound/step/grass`, `dirt`, `sand`, `stone`, `wood`, `mud` |
| loops | `sound/loop/wind`, `wind-strong`, `rain`, `sea`, `cicadas`, `frogs` |
| stingers | `sound/music/sting-start`, `sting-duel`, `sting-win` |
| UI | `sound/ui/select` |

Effects: `vfx/clash-sparks`, `deflect-flash`, `perfect-flash`, `blood-mist`, `slash-arc`, `dodge-dust`, `dust-step`, `petals`, `leaves`, `rain`, `rain-splash`, `fireflies`, `embers`.

## 11. What is built and what is not

Built in phase 1: the island (generated terrain, pampas and bamboo that bend in the wind, cedars, maples, rocks, the village, the shrine, paths), three looks, Aya and the five raider kinds as characters that show on the Character bench with their own clips and state graphs, the follow camera, run, sprint, a placeholder swing, the raiders standing in the world (they face Aya when she comes near, flinch when hit and fall), sounds, effects, a cover, a deterministic test.

Not built (phase 2 and after): the combat kit hookup (stances, posture, block and deflect, dodge i-frames, enemy brains, lock-on, standoff), the boss duel, the move-set and enemy configs, levels as separate scenes, a title screen, saves, voice and story lines.
