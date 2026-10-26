import { z } from 'zod'
import type { ChangedFile, ReviewTarget } from './types'

/** Lines are 1-based, inclusive, in the HEAD file; for a deleted file, 'change' lines refer to BASE. */
export const CodeSegment = z.object({
  kind: z.enum(['change', 'context']),
  path: z.string(),
  startLine: z.number().int(),
  endLine: z.number().int(),
  note: z.string().optional()
})
export type CodeSegment = z.infer<typeof CodeSegment>

export const Step = z.object({
  id: z.string(),
  title: z.string(),
  /** Marks a detour off an earlier step. */
  parentId: z.string().optional(),
  /** Empty for the first step. */
  whyNext: z.string(),
  explanation: z.string(),
  segments: z.array(CodeSegment)
})
export type Step = z.infer<typeof Step>

export const AgentWalkthrough = z.object({
  summary: z.string(),
  steps: z.array(Step)
})
export type AgentWalkthrough = z.infer<typeof AgentWalkthrough>

export type Walkthrough = AgentWalkthrough & {
  target: ReviewTarget
  files: ChangedFile[]
  changedLines: number
  /** The agent session that generated the walkthrough. */
  sessionId: string
  /** The chat's own agent session, once a question has started one. */
  chatSessionId?: string
}

export const agentWalkthroughJsonSchema = z.toJSONSchema(AgentWalkthrough, { target: 'draft-7' })
