import type { ProviderContent, ProviderPrompt } from "@getpaseo/plugin/server/provider";

export class ImagePromptError extends Error {
  constructor() {
    super("This Grok agent does not accept image prompts");
    this.name = "ImagePromptError";
  }
}

export function promptText(prompt: ProviderPrompt): string {
  if (prompt.input.type === "command") {
    const args = prompt.input.arguments.trim();
    return args.length > 0 ? `/${prompt.input.name} ${args}` : `/${prompt.input.name}`;
  }
  return prompt.input.content
    .map((part) => partText(part))
    .filter((part) => part.length > 0)
    .join("\n\n");
}

function partText(part: ProviderContent): string {
  switch (part.type) {
    case "text":
      return part.text;
    case "image":
      throw new ImagePromptError();
    case "uploaded_file":
      return `File: ${part.fileName} (${part.path})`;
    case "forge_change_request":
    case "github_pr":
      return labeled(part.title, part.url, part.body);
    case "forge_issue":
    case "github_issue":
      return labeled(part.title, part.url, part.body);
    case "review":
      return part.comments.map((comment) => `${comment.filePath}:${comment.lineNumber} ${comment.body}`).join("\n");
  }
}

function labeled(title: string, url: string, body: string | null | undefined): string {
  const text = body?.trim();
  return text ? `${title}\n${url}\n${text}` : `${title}\n${url}`;
}
