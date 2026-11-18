// How an out-of-scope roast ends. The model never sees its own past replies, so variety
// comes from here: a weighted pick that avoids the styles this chat saw most recently.

const ENDINGS = Object.freeze({
  chatgpt: { weight: 3, rule: 'End by sending them to ChatGPT.', samples: ['ChatGPT exists. Use it.', "That's a ChatGPT problem.", 'Take it up with ChatGPT.', 'ChatGPT is one tab away.', 'Ask ChatGPT, it lives for this.', 'Go bother ChatGPT.'] },
  diy: { weight: 3, rule: 'Do NOT mention ChatGPT or any tool. End by telling them to deal with it themselves.', samples: ['Figure it out, you have hands.', 'Google is free. Go.', 'Sounds like a you problem.', 'Good luck with that.', 'You got this. Alone.', 'Deal with it, champ.'] },
  mic: { weight: 2, rule: 'Do NOT mention ChatGPT or any tool. End on the roast itself, no redirect at all.', samples: [] },
  tokens: { weight: 2, rule: 'Do NOT mention ChatGPT. End with the token-saver bit: you are not made of tokens, they are burning yours, if they want it so badly they can pay for it themselves. No swearing.', samples: ["I'm not made of tokens, you know.", "You want it that badly? Pay for it yourself.", "Why are you burning my tokens on this?", "I'm low on tokens already, not wasting them on you.", "That's not worth a single token.", "Token budget says no."] },
  knife: { weight: 1, rule: 'End by sending them to ChatGPT with a twist of the knife.', samples: ["Just use ChatGPT, that's all you know anyway, isn't it?", "ChatGPT. It's the only thing you know how to open anyway."] },
});

// Openers / jabs: a few are offered per message so the same words don't show up every time.
const JABS = [
  'Are you dumb?', 'Genuinely?', 'Big-brain move.', 'You good?', 'Bold.', 'Respectfully, no.', 'Wrong room.', 'Be so serious.',
  'In this economy?', 'Read the room.', 'Not you asking me this.', 'The audacity.', 'Main character energy.', 'Sir, this is a club chat.',
  'Who let you cook?', 'Absolutely not.', 'I am begging you.', 'Delete this.', 'We were doing so well.', 'Brave of you.',
  "I'm a secretary, not a search engine.", 'This is why the group chat is quiet.', 'Did you lose a bet?', 'Touch grass.',
];

function sample(list, n, random = Math.random) {
  return [...list].sort(() => random() - 0.5).slice(0, n);
}
const AVOID_LAST = 2;
const KEEP = 6;

export function pickEnding(recent = [], random = Math.random) {
  const blocked = new Set(recent.slice(-AVOID_LAST));
  const options = Object.entries(ENDINGS).filter(([name]) => !blocked.has(name));
  const total = options.reduce((sum, [, e]) => sum + e.weight, 0);
  let roll = random() * total;
  for (const [name, e] of options) {
    roll -= e.weight;
    if (roll < 0) return name;
  }
  return options[options.length - 1][0];
}

// Picks this message's ending for the chat and remembers it.
export async function nextEnding(store, chatId) {
  const key = `roast:${chatId}`;
  const recent = (await store.kvGet(key, 30 * 24 * 3600 * 1000).catch(() => undefined)) || [];
  const name = pickEnding(recent);
  await store.kvSet(key, [...recent, name].slice(-KEEP)).catch(() => {});
  return name;
}

export function endingRule(name, random = Math.random) {
  const e = ENDINGS[name];
  const ideas = e.samples.length ? ` Ideas for the ending (write your own in this spirit, don't copy): ${sample(e.samples, 2, random).map((x) => `"${x}"`).join(', ')}.` : '';
  const jabs = sample(JABS, 2, random).map((x) => `"${x}"`).join(', ');
  return `\nIF (and only if) this message is out of scope and you roast it: ${e.rule}${ideas} For the roast itself, be creative and fit the situation (what they asked, how they asked, what they asked before); jabs like ${jabs} are ideas, not a script, and you can invent your own. Avoid "Genuinely" and "Big-brain move" unless offered here. Never swear. Mention Claude ONLY if the question is about writing or fixing code; otherwise never name Claude.`;
}
