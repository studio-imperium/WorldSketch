// Persistent generation history. Each generation (or uploaded splat) is saved to
// IndexedDB so the gallery survives reloads AND the most recent world per plot can
// be re-seated on boot. We split storage into two stores: a light `entries` store
// (prompt + thumbnail + timestamp) the gallery lists cheaply, and a heavy `blobs`
// store (the RAW splat bytes, pre-cull) loaded only when a generation is restored —
// restoring re-runs the exact same cull/fit pipeline so it matches the original.

const DB_NAME = "worldsketch"
const DB_VERSION = 1
const ENTRY_STORE = "entries"
const BLOB_STORE = "blobs"
const MAX_ENTRIES = 40 // cap so the splat blobs don't grow without bound

let dbPromise = null

function openDB() {
	if (dbPromise) return dbPromise
	dbPromise = new Promise((resolve, reject) => {
		const req = indexedDB.open(DB_NAME, DB_VERSION)
		req.onupgradeneeded = () => {
			const db = req.result
			if (!db.objectStoreNames.contains(ENTRY_STORE)) {
				const store = db.createObjectStore(ENTRY_STORE, { keyPath: "id", autoIncrement: true })
				store.createIndex("ts", "ts")
				store.createIndex("plotId", "plotId")
			}
			if (!db.objectStoreNames.contains(BLOB_STORE)) {
				db.createObjectStore(BLOB_STORE, { keyPath: "id" })
			}
		}
		req.onsuccess = () => resolve(req.result)
		req.onerror = () => reject(req.error)
	})
	return dbPromise
}

// Save one generation. `bytes` MUST be an independent copy of the raw splat bytes
// (the caller slices before handing the original to the splat loader, which may
// detach the buffer). Returns the stored entry incl. its assigned id.
export async function addGeneration({ plotId, prompt, thumb, bytes }) {
	const db = await openDB()
	const entry = { plotId, prompt: prompt || "", thumb: thumb || "", ts: Date.now() }
	const id = await new Promise((resolve, reject) => {
		const t = db.transaction([ENTRY_STORE, BLOB_STORE], "readwrite")
		let key
		const addReq = t.objectStore(ENTRY_STORE).add(entry)
		addReq.onsuccess = () => {
			key = addReq.result
			t.objectStore(BLOB_STORE).put({ id: key, bytes })
		}
		t.oncomplete = () => resolve(key)
		t.onerror = () => reject(t.error)
		t.onabort = () => reject(t.error)
	})
	await prune()
	return { ...entry, id }
}

// Newest-first list of lightweight entries (no splat bytes).
export async function listGenerations() {
	const db = await openDB()
	return new Promise((resolve, reject) => {
		const req = db.transaction(ENTRY_STORE, "readonly").objectStore(ENTRY_STORE).getAll()
		req.onsuccess = () => resolve((req.result || []).sort((a, b) => b.ts - a.ts))
		req.onerror = () => reject(req.error)
	})
}

// The raw splat bytes for one entry, or null if missing.
export async function getGenerationBytes(id) {
	const db = await openDB()
	return new Promise((resolve, reject) => {
		const req = db.transaction(BLOB_STORE, "readonly").objectStore(BLOB_STORE).get(id)
		req.onsuccess = () => resolve(req.result?.bytes || null)
		req.onerror = () => reject(req.error)
	})
}

export async function deleteGeneration(id) {
	const db = await openDB()
	return new Promise((resolve, reject) => {
		const t = db.transaction([ENTRY_STORE, BLOB_STORE], "readwrite")
		t.objectStore(ENTRY_STORE).delete(id)
		t.objectStore(BLOB_STORE).delete(id)
		t.oncomplete = () => resolve()
		t.onerror = () => reject(t.error)
	})
}

export async function clearGenerations() {
	const db = await openDB()
	return new Promise((resolve, reject) => {
		const t = db.transaction([ENTRY_STORE, BLOB_STORE], "readwrite")
		t.objectStore(ENTRY_STORE).clear()
		t.objectStore(BLOB_STORE).clear()
		t.oncomplete = () => resolve()
		t.onerror = () => reject(t.error)
	})
}

// Most recent saved generation for a given plot id (e.g. "0,0"), or null.
export async function latestForPlot(plotId) {
	const all = await listGenerations()
	return all.find(entry => entry.plotId === plotId) || null
}

// Drop the oldest entries (and their blobs) once we exceed MAX_ENTRIES.
async function prune() {
	const all = await listGenerations()
	const extra = all.slice(MAX_ENTRIES)
	if (!extra.length) return
	const db = await openDB()
	await new Promise((resolve, reject) => {
		const t = db.transaction([ENTRY_STORE, BLOB_STORE], "readwrite")
		for (const entry of extra) {
			t.objectStore(ENTRY_STORE).delete(entry.id)
			t.objectStore(BLOB_STORE).delete(entry.id)
		}
		t.oncomplete = () => resolve()
		t.onerror = () => reject(t.error)
	})
}
