// TODO-hock: stand-in for grammy's InlineKeyboard (the source bot was a
// Telegram bot). Same chainable shape; produces a plain rows array that any
// HOCK UI surface can render as buttons.
export class InlineKeyboard {
  constructor() { this.rows = [[]]; }
  text(label, data) { this.rows[this.rows.length - 1].push({ text: label, callback_data: data }); return this; }
  url(label, href) { this.rows[this.rows.length - 1].push({ text: label, url: href }); return this; }
  row() { this.rows.push([]); return this; }
  toJSON() { return { inline_keyboard: this.rows.filter((r) => r.length) }; }
}
