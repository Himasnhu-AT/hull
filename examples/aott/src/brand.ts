// AOTT brand sheet: the one place the game's names live. Every player-facing string (HUD, subtitles, mission text,
// narration, flags, feed) uses these names.

export const TITLE = 'AOTT';
export const TAGLINE = 'Hold the last wall.';

/** Factions and kit. */
export const ORG = {
  scouts: 'the Outriders',          // the expedition corps (green cloaks)
  scoutsShort: 'Outriders',
  scout: 'Outrider',
  wallguard: 'the Wallguard',        // the wall's standing defence
  wallguardShort: 'Wallguard',
  gear: 'tether gear',              // the grapple-and-gas rig
  gearShort: 'TG',
} as const;

/** Places. */
export const PLACE = {
  innerWall: 'the Ashwall',         // the wall the player defends
  outerWall: 'the Old Wall',        // the fallen outer wall
  town: 'Varn',                     // the gate town behind the wall
  townLong: 'Varn District',
  homeTown: 'Holm',                 // the protagonist's lost home town
  forest: 'the Greatwood',          // the forest of giant trees
  plain: 'the Reach',               // the open land beyond the wall
} as const;

/** Giants. Ordinary ones stay "titans". */
export const GIANT = {
  behemoth: 'the Behemoth',         // the 60 m giant that appears at the wall
  behemothShort: 'Behemoth',
  huntress: 'the Huntress',         // the intelligent female shifter in the forest
  huntressShort: 'Huntress',
  shifterGiant: "Kael's giant",     // the recruit who turns into a giant
} as const;

/** People. Keys are roles, so code refers to people by what they do. */
export const CAST = {
  shifter: 'Kael',                  // the recruit who becomes a giant
  ace: 'Wren',                      // his sister-in-arms, the best blade in the squad
  strategist: 'Tobin',              // the clever friend
  captain: 'Captain Vance',         // the corps' best soldier, leads the special squad
  captainShort: 'Vance',
  commander: 'Commander Halvard',   // the corps commander
  commanderShort: 'Halvard',
  huntressHuman: 'Sigrun',          // the Huntress' human form
  shield: 'Brandt',                 // the big, steady recruit
  rival: 'Matthis',                 // the sharp-tongued recruit
  joker: 'Rudi',
  flareOfficer: 'Greta',            // Wallguard elite who fires the flares
  squadLeader: 'Captain Oswin',     // leads the elite squad at the gate
  squadLeaderShort: 'Oswin',
  wallguardElite: 'Falk',
  squadA: 'Liesl',                  // the captain's squad
  squadB: 'Dorran',
  squadC: 'Henrik',
  squadD: 'Ulric',
  riderA: 'Pell',                   // right-wing riders
  riderB: 'Corwin',
  researcher: 'Ysolde',
  cadet: 'Elke',                    // the cadet who brings up the spare horses
  general: 'Commander Aldous',      // the Wallguard's commander
} as const;

/** Modes and missions. */
export const MISSION = {
  waves: 'Holdout',                 // endless waves (mode id 'expedition')
  gate: 'Seal the Breach',          // escort the shifter's giant and the boulder to the gate
  gateBattle: 'the Battle of Varn',
  sortie: 'The Twelfth Sortie',     // the four-act cinematic expedition
  formation: 'the Wide Line',       // the long-range scouting formation
  training: 'Training Yard',
  free: 'Free Flight',
} as const;

/** Moves. */
export const MOVE = {
  spin: 'whirlwind cut',            // the spinning slash at speed
} as const;
