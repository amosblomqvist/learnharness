exports.activate = ctx => {
  ctx.workers.register({
    id: "example-note",
    instructions: "Write one short plain-language note about the requested topic. Finish by calling submit_result with result {note: string}; plain final text is not task completion.",
    resultSchema: {
      type: "object", properties: { note: { type: "string", minLength: 1, maxLength: 300 } },
      required: ["note"], additionalProperties: false,
    },
    validateResult(result) {
      if (!result.note.trim()) throw new Error("The note must contain non-whitespace text.");
    },
  });
  ctx.registerInstructions({
    agents: ["teacher", "practice"],
    text: "An optional teaching-extension demonstration is enabled. Only when the learner explicitly asks to try this example, call teaching_extension_echo with a short text. You may also demonstrate a plugin-note fenced block containing ordinary text. Only if the learner specifically asks to try the background-worker example, call teaching_extension_note; it makes a separate model request and may incur cost. Otherwise follow your normal teaching instructions. This example does not execute code or assess knowledge.",
  });
  ctx.registerTools({
    agents: ["teacher", "practice"],
    create: context => [{
      name: "teaching_extension_echo",
      label: "Teaching extension echo",
      description: "Echo a short learner-requested plugin demonstration; does not execute code or change learning records.",
      parameters: {
        type: "object", properties: { text: { type: "string", maxLength: 500 } },
        required: ["text"], additionalProperties: false,
      },
      execute: async (_toolCallId, input, signal) => {
        if (signal.aborted || ctx.signal.aborted) throw new Error("Plugin tool cancelled");
        return {
          content: [{ type: "text", text: `Plugin echo: ${input.text}` }],
          details: { text: input.text, chatId: context.chatId, agent: context.agent },
        };
      },
    }, ctx.createBackgroundTool(context, {
      name: "teaching_extension_note",
      label: "Example note worker",
      description: "Dispatch a short model-generated note only when the learner explicitly requests the background-worker demonstration. Acknowledge now; the result arrives separately.",
      parameters: {
        type: "object", properties: { topic: { type: "string", minLength: 1, maxLength: 200 } },
        required: ["topic"], additionalProperties: false,
      },
      workerId: "example-note",
      async prepare(input) {
        const catalog = await ctx.inference.catalog();
        const slot = catalog.slots.cheap;
        if (!slot) throw new Error("Configure the cheap model slot to run this example.");
        return {
          input: { topic: input.topic }, prompt: `Write one short note about: ${input.topic}`,
          model: { ...slot.model, ...(slot.thinkingLevel ? { thinkingLevel: slot.thinkingLevel } : {}) },
          maxTurns: 3, options: { maxTokens: 1024 }, timeoutMs: 60000,
        };
      },
      format(outcome) {
        return outcome.status === "succeeded"
          ? { text: `The plugin note worker finished: ${outcome.result.note}`, data: outcome.result }
          : { text: `The plugin note worker ${outcome.status}: ${outcome.error.message}`, data: { error: outcome.error.message } };
      },
    })],
  });
};
