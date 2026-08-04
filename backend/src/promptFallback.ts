// Offline fallback for POST /api/prompt/improve, used when no prompt helper
// endpoint is configured.

export function improveTextPromptLocally(prompt: string) {
  const currentPromptMatch = prompt.match(/current prompt:\s*([\s\S]*?)(?:\n[A-Z][^\n]*:|\nReturn only|\s*$)/i);
  const currentPrompt = (currentPromptMatch?.[1] ?? prompt)
    .replace(/^["']|["']$/g, "")
    .replace(/\s+/g, " ")
    .trim();

  if (!currentPrompt) {
    return prompt.trim();
  }

  const cleaned = currentPrompt.replace(/[.。]+$/g, "");
  return `${cleaned}, with clear subject preservation, natural realistic details, consistent lighting, clean edges, and no unwanted changes to the surrounding scene.`;
}
