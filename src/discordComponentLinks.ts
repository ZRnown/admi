export interface DiscordComponentLink {
  label: string;
  url: string;
}

function getRawComponent(component: any): any {
  if (!component || typeof component !== "object") return component;
  if (typeof component.toJSON === "function") {
    try {
      return component.toJSON();
    } catch {}
  }
  return component.data && typeof component.data === "object" ? component.data : component;
}

function collectFromComponent(component: any, links: DiscordComponentLink[], seen: Set<string>): void {
  const raw = getRawComponent(component);
  if (!raw || typeof raw !== "object") return;

  const childGroups = [
    raw.components,
    raw.children,
    raw.items,
    raw.accessory ? [raw.accessory] : undefined,
  ];
  for (const group of childGroups) {
    if (!Array.isArray(group)) continue;
    for (const child of group) {
      collectFromComponent(child, links, seen);
    }
  }

  const url = typeof raw.url === "string" ? raw.url.trim() : "";
  if (!/^https?:\/\//i.test(url) || seen.has(url)) return;
  seen.add(url);

  const label = typeof raw.label === "string" && raw.label.trim() ? raw.label.trim() : "链接";
  links.push({ label, url });
}

export function extractDiscordComponentLinks(components: any[] | undefined | null): DiscordComponentLink[] {
  if (!Array.isArray(components) || components.length === 0) return [];

  const links: DiscordComponentLink[] = [];
  const seen = new Set<string>();
  for (const component of components) {
    collectFromComponent(component, links, seen);
  }
  return links;
}

export function appendDiscordComponentLinks(
  content: string,
  components: any[] | undefined | null,
  options?: { format?: "plain" | "markdown" },
): string {
  const links = extractDiscordComponentLinks(components);
  if (links.length === 0) return content;

  const format = options?.format || "plain";
  const lines = links.map((link) =>
    format === "markdown"
      ? `[${link.label.replace(/[[\]\\]/g, "\\$&")}](${link.url})`
      : `${link.label}: ${link.url}`,
  );
  const base = String(content || "").trim();
  return [base, ...lines].filter(Boolean).join("\n");
}
