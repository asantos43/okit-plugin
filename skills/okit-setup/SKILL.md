---
name: okit-setup
description: Use when the user invokes /okit-setup or asks to configure the plugin's models through a conversation, showing what will be written before anything is saved.
---

# Setup

Run the setup the plugin already has. Never choose a model by hand, never edit the configuration file and never write an individual setting yourself.

- Detect and ask first: run `okit-plugin setup` once and read what it reports — the installed clients, the model it proposes for each work class and why. It shows the complete proposal and writes nothing until the final confirmation, so a refused run changes nothing. If the command is not found, run `node "${CLAUDE_PLUGIN_ROOT}/src/cli.js"` with the same arguments.
- Explain the proposal in plain words: which client, which work class, which model and why that one.
- Ask only what was not detected. A detected model is a fact: report it, do not ask about it.
- When the user wants a model of their own, give that model as the answer to the setup's own model question; `setup` has no option that takes a model as an argument. Never use the configuration write command.
- Save only through the setup's final confirmation, after the user has seen and accepted the complete proposal. The setup writes the complete set once; a refusal leaves everything unchanged.
- When the setup says the configuration file is not readable, tell the user that and how to fix it with `okit-plugin config show`. Write nothing yourself and do not ask for models: the setup cannot run until the configuration is readable.
- Finish by saying what was written: the client, the work class and the model of every saved choice, and that the setup is done. If the user refused, say that nothing was changed.
