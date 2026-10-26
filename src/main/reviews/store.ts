import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'
import { SavedReviewSchema, type SavedReview } from '../../shared/reviews'

export interface ReviewStore {
  list(): SavedReview[]
  get(id: string): SavedReview | null
  findByKey(key: string): SavedReview | null
  save(review: SavedReview): void
  remove(id: string): void
}

const isPlainId = (id: string): boolean =>
  id !== '' && !id.includes('/') && !id.includes('\\') && !id.includes('..')

export function createReviewStore(dir: string): ReviewStore {
  const fileFor = (id: string): string => join(dir, `${id}.json`)

  const readFile = (path: string): SavedReview | null => {
    try {
      const parsed = SavedReviewSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')))
      return parsed.success ? parsed.data : null
    } catch {
      return null
    }
  }

  const list = (): SavedReview[] => {
    if (!existsSync(dir)) return []
    const out: SavedReview[] = []
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.json')) continue
      const r = readFile(join(dir, name))
      if (r) out.push(r)
    }
    return out
  }

  const get = (id: string): SavedReview | null => (isPlainId(id) ? readFile(fileFor(id)) : null)

  const findByKey = (key: string): SavedReview | null => list().find((r) => r.key === key) ?? null

  const save = (review: SavedReview): void => {
    mkdirSync(dir, { recursive: true })
    const path = fileFor(review.id)
    const tmp = `${path}.tmp`
    writeFileSync(tmp, JSON.stringify(review, null, 2))
    renameSync(tmp, path)
  }

  const remove = (id: string): void => {
    if (!isPlainId(id)) return
    rmSync(fileFor(id), { force: true })
  }

  return { list, get, findByKey, save, remove }
}
