// Leaving a text box with the keyboard.
//
// Enter (keep the value) and Escape (drop it) end an edit by taking the focus out of the box. That has to happen on
// key-up. Blurring inside the key-down handler made Chromium keep repeating the key (a stream of "Unidentified"
// key-downs), and as soon as a button was focused the stream "clicked" it over and over, which froze the page.

/** Use as `onKeyUp`: Enter and Escape leave the box. The key-down handler only changes state (Escape clears the draft). */
export function leaveBox(e: { key: string; currentTarget: { blur(): void } }): void {
  if (e.key === 'Enter' || e.key === 'Escape') e.currentTarget.blur();
}
