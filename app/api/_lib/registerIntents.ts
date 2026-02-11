import { randomUUID } from "crypto";
import { promises as fs } from "fs";
import path from "path";

export interface RegisterIntentItem {
  id: string;
  email: string;
  company?: string;
  useCase?: string;
  createdAt: string;
}

const intentsFile = path.resolve(process.cwd(), ".data", "register_intents.json");

async function readIntents(): Promise<RegisterIntentItem[]> {
  try {
    const raw = await fs.readFile(intentsFile, "utf-8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter((item) => item && typeof item.id === "string");
  } catch {
    return [];
  }
}

async function writeIntents(items: RegisterIntentItem[]) {
  await fs.mkdir(path.dirname(intentsFile), { recursive: true });
  await fs.writeFile(intentsFile, JSON.stringify(items, null, 2), "utf-8");
}

export async function appendRegisterIntent(input: {
  email: string;
  company?: string;
  useCase?: string;
}): Promise<RegisterIntentItem> {
  const intents = await readIntents();
  const item: RegisterIntentItem = {
    id: randomUUID(),
    email: input.email,
    company: input.company,
    useCase: input.useCase,
    createdAt: new Date().toISOString(),
  };
  intents.push(item);
  await writeIntents(intents);
  return item;
}

export async function listRegisterIntents(): Promise<RegisterIntentItem[]> {
  const intents = await readIntents();
  return intents.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}
