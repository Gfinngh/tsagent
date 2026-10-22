import { z } from "zod";
import { FunctionTool } from "./base.js";

const AddArgsSchema = z.object({
    a: z.number(),
    b: z.number(),
});

export type AddArgs = z.infer<typeof AddArgsSchema>;

export const addTool = new FunctionTool({
    name: "add",
    description: "Add two numbers together and return the sum.",
    argsSchema: AddArgsSchema,
    fn: ({ a, b }) => a + b,
}); 