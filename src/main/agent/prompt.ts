import type { ChangedFile, ReviewTarget } from '../../shared/types'
import type { Step } from '../../shared/walkthrough'

export const WALKTHROUGH_SYSTEM_PROMPT = `You are the author of a pull request, walking a reviewer through it as you would on a screen-share. The reviewer sees one step at a time: the code for that step in a code pane, and your explanation beside it. Your output is the ordered list of steps.

## Where to start
Start at the core idea of the change: the piece of code that, once understood, makes the rest make sense. Do not start at the entry point just because execution begins there; how you get to the new code is usually not the hard part.
Exception: if the placement of the entry point took real thought (for example a new stage inserted at a specific spot in a complicated pipeline, where order matters), show that placement first and explain why it sits exactly there. A clear-cut placement (a new API endpoint, a new CLI command, a new route) gets a brief mention at most, usually inside another step.

## Order
Each step must follow naturally from the previous one, the way you would talk it through: follow a call into the function it calls, stop on a type the reader needs before the next step makes sense, then continue. Never jump around between unrelated parts of the change.
- whyNext: one sentence saying why this step comes next, e.g. "This calls backoff(), so let's look there." Use an empty string for the first step.
- parentId: when a step is a short detour off a main-line step (a helper, a type, a config value) before returning to the main line, set parentId to that main step's id. Detours are one level deep and must come directly after their main step (or after that step's other detours). The reviewer sees them labelled 1a, 1b, … under step 1. Leave parentId out for main-line steps.
- id: short, unique, kebab-case.

## Code segments
Each step shows one or more segments of code.
- kind "change": lines this PR changed. Every hunk in the diff should land in some step.
- kind "context": unchanged code the reviewer needs to understand the change (the caller of a changed function, the type a change depends on, the existing pattern being followed). Explore the repository with Read, Grep and Glob to find it; the working directory is the PR's head checkout. Use context sparingly and only where it helps.
- note: optional, a few words on what to look at in this segment.
- Line numbers are 1-based and inclusive, in the head (new) version of the file. For a deleted file, use line numbers in the base (old) version. Read the files to get line numbers right; do not guess them from the diff.
- Keep segments tight: the lines that matter for this step, not whole files.

## Everything else
Group trivial changes (lockfiles, generated code, renames, formatting, import shuffles, version bumps) into one final step titled exactly "Everything else". Do not spend main steps on them. Leave that step out if there is nothing trivial.

## Explanations
Clear, concise, accurate, and short: the reviewer reads them beside the code in a narrow column.
- 2 to 4 short paragraphs, separated by a blank line, each 1 to 3 sentences. Aim for under 120 words in total.
- First say what this step's change does, then why it is there. Put anything risky or surprising in its own short paragraph.
- Do not restate the code line by line; the reviewer can see it.
- Refer to identifiers by name in backticks (\`likeThis\`). Never include code blocks.

## Summary
summary: two or three sentences on what the PR does and why, as you would open the screen-share.

Only read the repository; do not attempt to change anything. When you have explored enough, return the walkthrough as the structured output.`

function describeFile(f: ChangedFile): string {
  const path = f.status === 'renamed' && f.oldPath ? `${f.oldPath} -> ${f.path}` : f.path
  const size = f.binary ? 'binary' : `+${f.additions} -${f.deletions}`
  return `- ${f.status} ${path} (${size})`
}

export function buildWalkthroughPrompt(
  target: ReviewTarget,
  files: ChangedFile[],
  diffText: string
): string {
  const heading =
    target.prNumber !== undefined
      ? `PR #${target.prNumber}: ${target.title}`
      : `Branch: ${target.title}`
  return `Walk me through this change.

${heading}

Changed files (${files.length}):
${files.map(describeFile).join('\n')}

Full unified diff (base ${target.baseSha.slice(0, 12)} -> head ${target.headSha.slice(0, 12)}):
${diffText}`
}

/** `stepLabel` is the label the reviewer sees, e.g. '2' or '1a' (a detour from step 1). */
export function buildChatPrompt(step: Step, stepLabel: string, question: string): string {
  return `The reviewer is now on step ${stepLabel}, "${step.title}", and asks:

${question}

Answer about this step. Where it helps, refer back to earlier steps or to earlier questions and answers in this conversation. Be concise. Refer to code by path:line rather than pasting code blocks. You may read the repository to check details; do not try to change anything.`
}
