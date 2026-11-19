// The tour is one game being made, start to finish, in four chapters. Each step names the scene the replica plays
// (Replica.tsx), and says in a sentence what the person does there. The words match the app's own buttons.

export type SceneId = 'home-type' | 'home-enter' | 'ask' | 'plan' | 'edit' | 'updated' | 'approve' | 'build' | 'play' | 'off' | 'fix' | 'share';
export interface StoryStep { title: string; say: string; scene: SceneId }
export interface Chapter { title: string; steps: StoryStep[] }

export const CHAPTERS: readonly Chapter[] = [
  { title: 'Your idea', steps: [
    { scene: 'home-type', title: 'Type your idea', say: 'On the home page, write the game you want in a sentence, like a chat message.' },
    { scene: 'home-enter', title: 'Press Enter', say: 'Press Enter. Hull makes a folder for the game and your sentence goes to the builder.' },
    { scene: 'ask', title: 'The builder asks', say: 'The builder answers with a short question. Click an answer, or type your own.' },
    { scene: 'plan', title: 'It writes the plan', say: 'From your answers it writes the plan, part by part, right in the chat.' },
  ] },
  { title: 'The plan', steps: [
    { scene: 'edit', title: 'Change what you want', say: 'Press Change on any part, or just type what you want different and press Enter.' },
    { scene: 'updated', title: 'It updates the plan', say: 'The builder rewrites that part. Ask again as many times as you like.' },
    { scene: 'approve', title: 'Approve it', say: 'When it reads right, press Looks right, build it.' },
  ] },
  { title: 'The build', steps: [
    { scene: 'build', title: 'It builds in stages', say: 'The builder makes the world, the characters, the animations, the rules, the sounds, the effects and the screens. Each stage is checked before the next.' },
    { scene: 'play', title: 'Play it', say: 'When every stage is done, the game is ready. Play it right there in the app.' },
  ] },
  { title: 'Play, fix, share', steps: [
    { scene: 'off', title: 'Something is off', say: 'Press N when something feels wrong. The game freezes, and you say what is off in your own words.' },
    { scene: 'fix', title: 'It fixes that one thing', say: 'The builder changes what is behind it and you see the change live. Every change is kept and can be put back.' },
    { scene: 'share', title: 'Share it', say: 'When it is done, Share makes one JavaScript file that runs on the web and on the desktop.' },
  ] },
];
