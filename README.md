# WorldSketch

WorldSketch turns a browser-built block-out into a detailed image with Qwen-Image-Edit-2509, then converts that image into a Gaussian splat with TripoSplat. The image step uses a public Hugging Face Space by default, or the user's monthly inference credits when they enable that setting. TripoSplat runs through a public Space using the user's ZeroGPU allowance. The WorldSketch server never receives or stores the user's Hugging Face token, source image, generated image, or splat.

The deployment is a static site plus two tiny serverless functions: `client/` is served as-is (no build step), and `api/config.mjs` / `api/healthz.mjs` provide `/api/config` and `/healthz`. `vercel.json` wires up the rewrites, caching, and security headers. A legacy Go server (`server/` + `Dockerfile`) can serve the same client for self-hosting.

Dev-only fixtures (session ZIPs and primitive JSONs for testing splat flows without spending GPU quota) live in `fixtures/` and are not deployed.

## Run locally

Requirements: a modern browser, plus either Node (for `vercel dev`) or Go 1.23+ (for the legacy server).

```sh
cp .env.example .env
npx vercel dev        # serves client/ + /api/config on http://localhost:3000
```

or with the Go server:

```sh
cd server && go run . # http://localhost:8067
```

The landing page's `Continue with Hugging Face` button starts the OAuth sign-in and then opens the editor at `/app/`. The included public OAuth client is already registered for the local root URL, so callbacks return to `/`, where the landing page finishes the token exchange.

## Deploy

Primary: push to the connected Vercel project (or `npx vercel deploy --prod`). Configuration is environment variables only — see `.env.example`; `WS_HF_REDIRECT_URL` is the one that must be set per domain.

Alternative, the stateless container:

```sh
docker build -t worldsketch .
docker run --rm -p 8067:8067 --env-file .env worldsketch
```

Before using a production domain:

1. Add the exact public HTTPS URL, including the trailing slash, to both the homepage and redirect URL fields in the WorldSketch OAuth application on Hugging Face.
2. Set `WS_HF_REDIRECT_URL` to that same URL in the deployment environment.
3. Deploy the container on any service that supplies a `PORT` environment variable. `/healthz` is the health-check endpoint.

No API keys or persistent volume are required. Scaling the web service horizontally is safe because generation state and user credentials stay in the browser. Public Spaces can change or become unavailable; the Space ID is an environment setting, although a replacement must expose the same Gradio input and output shape or the browser adapter must be updated with it.

**Image detail runs on Hugging Face inference credits by default** (`WS_HF_IMAGE_CREDITS=1`, a few ¢ per image via fal-ai): every ZeroGPU image route eventually died waiting in the GPU queue, so ZeroGPU is now only used for TripoSplat. Set `WS_HF_IMAGE_CREDITS=0` to route images through the Space below instead — the A/B lab follows the same switch. The credits model is `black-forest-labs/FLUX.2-dev` (32B, 28 steps/guidance 4): Qwen-Image-Edit-2509 only shaded the block-out's flat surfaces, while FLUX.2 actually interprets the geometry; `WS_HF_INFERENCE_MODEL` switches back (multi-image extras need a matching entry in `FAL_EDIT_PROVIDER_IDS`, huggingface-provider.js).

The A/B lab (`/ab/`) takes an optional **style guide** image — a reference whose art style the output should copy (say so in the prompt, e.g. "match the art style of the last input image"). On the credits route it rides a direct fal queue call (`falQueueImageEdit` — the official `@huggingface/inference` client can only carry one image); on multi-image Spaces it goes along as an extra gallery image.

The fallback image Space is `black-forest-labs/FLUX.1-Kontext-Dev` — a 12B editing model on HF's most-used ZeroGPU editing Space, so its workers stay warm and jobs don't die waiting in the GPU queue like the 20B Qwen routes kept doing. It takes a single input image (the geometry map is dropped and the prompt stops referencing it — `spaceSupportsGeometry` in huggingface-image.js) and runs its own tuned sampler (28 steps, guidance 2.5), so `WS_HF_IMAGE_STEPS`/`WS_HF_IMAGE_GUIDANCE` do not apply. `WS_HF_IMAGE_SPACE` can point back at `akhaliq/Qwen-Image-Edit-2509` (two-image 8-step Lightning, 60s reservation — kept aborting in the GPU queue), the official `Qwen/Qwen-Image-Edit-2509` (reserves 600s/run, above every normal account's ceiling), `WilliamQM/Qwen-Image-Edit-2509` (120s duplicate, queue wedged), or `black-forest-labs/FLUX.2-dev` / `FLUX.2-klein-4B`.

The checked-in defaults are a production preset: a 1024×1024 image with 20 editing steps, 30 TripoSplat steps at guidance 3, and 131,072 Gaussians (`WS_HF_TRIPO_GAUSSIANS` can raise this to TripoSplat's 262,144 maximum). ZeroGPU checks that the declared reservation fits within the remaining quota before starting, then accounts for the GPU time used.

`Inference credits for image detail` is off by default. When enabled in the editor settings, the image-detail step uses Hugging Face Inference Providers (fal) instead of ZeroGPU; a single edit is typically a few cents. Splats use the direct TripoSplat server when `TRIPOSPLAT_URL` is set, otherwise ZeroGPU. WorldSketch never falls back to the paid route unless the setting is enabled.

## Security and quota behavior

- Sign-in uses OAuth Authorization Code with PKCE. The access token is stored in session storage for the current tab so the sign-in page can open the editor; it disappears when the tab is closed or the user signs out.
- WorldSketch asks for `openid profile inference-api`; it has no repository or account write permission. The inference permission can spend monthly inference credits only when `Use inference credits` is enabled.
- Prompt rewriting is disabled, so the image stage stays entirely on the selected Hugging Face Space.
- Jobs are not retried automatically because retries could consume GPU allowance twice.
- If a daily ZeroGPU allowance is exhausted, the app shows a plain-language error and leaves the build intact.
