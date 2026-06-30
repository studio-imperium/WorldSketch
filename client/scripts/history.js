// Persistent build history. Each completed generateWorld() build — the block-out at
// build time, every subject's raw splat bytes, the prompt + a thumbnail — is saved to
// IndexedDB so prior builds survive reloads and can be restored without regenerating.
// Storage is split into a light `meta` store (prompt + thumbnail + manifest, listed
// cheaply in the history panel) and a heavy `splats` store (the RAW splat bytes,
// loaded only when a build is restored — restore re-runs the exact same cull/fit
// pipeline so it matches the original).

const DB_NAME = "worldsketch_builds"
const DB_VERSION = 1
const META_STORE = "meta"     // { id, ts, prompt, thumb, subjectCount, subjects, primitives }
const SPLAT_STORE = "splats"  // { id, splats: { [name]: Uint8Array } }
const MAX_ENTRIES = 20        // cap so the splat blobs don't grow without bound

let dbPromise = null

function openDB() {
	if (dbPromise) return dbPromise
	dbPromise = new Promise((resolve, reject) => {
		const req = indexedDB.open(DB_NAME, DB_VERSION)
		req.onupgradeneeded = () => {
			const db = req.result
			if (!db.objectStoreNames.contains(META_STORE)) {
				const store = db.createObjectStore(META_STORE, { keyPath: "id", autoIncrement: true })
				store.createIndex("ts", "ts")
			}
			if (!db.objectStoreNames.contains(SPLAT_STORE)) {
				db.createObjectStore(SPLAT_STORE, { keyPath: "id" })
			}
		}
		req.onsuccess = () => resolve(req.result)
		req.onerror = () => reject(req.error)
	})
	return dbPromise
}

// Save one completed build. `splats` is the live `splatStore` (Map name → Uint8Array)
// or a plain {name: bytes} object; the bytes are COPIED (slice) so the splat loader
// can't detach the originals out from under us. `subjects` is the sessionSubjects
// manifest and `primitives` the serialized block-out (JSON string) — both are needed
// to re-seat on restore. Returns the stored meta incl. its assigned id.
export async function addBuild({ prompt, thumb, subjects, primitives, splats }) {
	const pairs = splats instanceof Map ? [...splats] : Object.entries(splats || {})
	const splatMap = {}
	for (const [name, bytes] of pairs) splatMap[name] = bytes.slice() // independent copy
	const meta = {
		ts: Date.now(),
		prompt: prompt || "",
		thumb: thumb || "",
		subjectCount: pairs.length,
		subjects: (subjects || []).map(s => ({ ...s })),
		primitives: primitives || "",
	}
	const db = await openDB()
	const id = await new Promise((resolve, reject) => {
		const t = db.transaction([META_STORE, SPLAT_STORE], "readwrite")
		const addReq = t.objectStore(META_STORE).add(meta)
		addReq.onsuccess = () => t.objectStore(SPLAT_STORE).put({ id: addReq.result, splats: splatMap })
		t.oncomplete = () => resolve(addReq.result)
		t.onerror = () => reject(t.error)
		t.onabort = () => reject(t.error)
	})
	await prune()
	return { ...meta, id }
}

// Newest-first list of lightweight build metadata (no splat bytes).
export async function listBuilds() {
	const db = await openDB()
	return new Promise((resolve, reject) => {
		const req = db.transaction(META_STORE, "readonly").objectStore(META_STORE).getAll()
		req.onsuccess = () => resolve((req.result || []).sort((a, b) => b.ts - a.ts))
		req.onerror = () => reject(req.error)
	})
}

// The raw splat bytes map ({name: Uint8Array}) for one build, or null if missing.
export async function getBuildSplats(id) {
	const db = await openDB()
	return new Promise((resolve, reject) => {
		const req = db.transaction(SPLAT_STORE, "readonly").objectStore(SPLAT_STORE).get(id)
		req.onsuccess = () => resolve(req.result?.splats || null)
		req.onerror = () => reject(req.error)
	})
}

export async function deleteBuild(id) {
	const db = await openDB()
	return new Promise((resolve, reject) => {
		const t = db.transaction([META_STORE, SPLAT_STORE], "readwrite")
		t.objectStore(META_STORE).delete(id)
		t.objectStore(SPLAT_STORE).delete(id)
		t.oncomplete = () => resolve()
		t.onerror = () => reject(t.error)
	})
}

export async function clearBuilds() {
	const db = await openDB()
	return new Promise((resolve, reject) => {
		const t = db.transaction([META_STORE, SPLAT_STORE], "readwrite")
		t.objectStore(META_STORE).clear()
		t.objectStore(SPLAT_STORE).clear()
		t.oncomplete = () => resolve()
		t.onerror = () => reject(t.error)
	})
}

// Drop the oldest builds (and their splats) once we exceed MAX_ENTRIES.
async function prune() {
	const all = await listBuilds()
	const extra = all.slice(MAX_ENTRIES)
	if (!extra.length) return
	const db = await openDB()
	await new Promise((resolve, reject) => {
		const t = db.transaction([META_STORE, SPLAT_STORE], "readwrite")
		for (const entry of extra) {
			t.objectStore(META_STORE).delete(entry.id)
			t.objectStore(SPLAT_STORE).delete(entry.id)
		}
		t.oncomplete = () => resolve()
		t.onerror = () => reject(t.error)
	})
}
