import { interruptController } from "../src/cli.js";
import { runPack } from "../src/run.js";

const [packDirectory, outputDirectory, origin] = process.argv.slice(2);
if (!packDirectory || !outputDirectory || !origin) throw new Error("pack, output and origin are required");

const interrupt = interruptController();
try {
  const output = await runPack({
    packDirectory,
    outputDirectory,
    apiKey: "test-key",
    modelConfiguration: { provider: "openrouter", model: "z-ai/glm-5.2" },
    environment: { TARGET_URL: origin, QA_ALLOWED_ORIGINS: origin },
    signal: interrupt.controller.signal,
    caseExecutor: async (input) => {
      const opened = await input.browser.open(`${origin}/`, "open-login", input.signal);
      const slow = opened.observation?.interactive.find((target) => target.name === "Slow check");
      process.stdout.write("SETTLING\n");
      await input.browser.click(slow!.ref, "open-login", input.signal);
      throw new Error("unreachable");
    },
  });
  process.exitCode = output.summary.exitCode;
} finally {
  interrupt.dispose();
}
