---
name: captain-inbox
description: "Walk the user through what needs them right now from their captain: open questions, to-dos and pages to read, in chat or on the inbox page, and record their answers. Run it when the user says /captain-inbox, \"what needs me\" or \"show my inbox\"."
disable-model-invocation: true
---

# Captain inbox

`captain` below means `node .captainstack/bin/captain.mjs`.

1. `captain inbox` lists what is open: questions (with their answers and the recommended one),
   to-dos and pages to read. Nothing open: say so in one line and stop.
2. Ask the user how they want to answer, unless they already said: on the inbox page (recommended
   when there is more than one question), or here in chat.
3. **On the page**: `captain serve --background`, then give the link
   `<server>/s/<captain>/inbox` (the footer prints it). Every open question is answerable there;
   pages to read are linked at the top. Their Send writes the answers back to files and wakes
   `captain watch`; read them with `captain answers` and act on each.
4. **In chat**: go through the questions one at a time, oldest first: the title, the full
   description, the answers with the recommended one marked. Record each answer as it comes:
   `captain answer Q<n> "<answer>"` (a letter picks that answer; words are kept as said), and a
   to-do they did: `captain inbox done Q<n>`. Then act on the answers as the captain skill says.
5. End with `captain footer`, so whatever is still open is the last thing they read.

In Ghostex this list sits above the chat box and on the phone; CaptainStack keeps it in files, the
inbox page and the footer at the end of every captain reply.
