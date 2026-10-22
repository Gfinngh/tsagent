import { z } from "zod";
import { FunctionTool } from "./base.js";

const GreetArgsSchema = z.object({
    name: z.string(),
});

export type GreetArgs = z.infer<typeof GreetArgsSchema>;

export const greetTool = new FunctionTool({
    name: "greet",
    description: "Greet a person by name.",
    argsSchema: GreetArgsSchema,
    fn: ({ name }) => `Hello, ${name}!`,
});