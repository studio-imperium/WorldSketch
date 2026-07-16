# WorldSketch

WorldSketch turns a browser-built block-out into a detailed image with Qwen-Image-Edit-2509, then converts that image into a Gaussian splat with TripoSplat. The image step uses a public Hugging Face Space by default, or the user's monthly inference credits when they enable that setting. TripoSplat runs through a public Space using the user's ZeroGPU allowance. The WorldSketch server never receives or stores the user's Hugging Face token, source image, generated image, or splat.

## Run locally

Requirements: Go 1.23+ and a modern browser.

```sh
cp .env.example .env
cd server
go run .
```

Open `http://localhost:8067/` for the landing page. `Log in` goes to the Hugging Face sign-in at `/login`, which then opens the editor at `/app/`. The included public OAuth client is already registered for the local root URL, so callbacks return to `/` and are handed to `/login` to finish.

## Deploy

Build and run the stateless container:

```sh
docker build -t worldsketch .
docker run --rm -p 8067:8067 --env-file .env worldsketch
```

Before using a production domain:

1. Add the exact public HTTPS URL, including the trailing slash, to both the homepage and redirect URL fields in the WorldSketch OAuth application on Hugging Face.
2. Set `WS_HF_REDIRECT_URL` to that same URL in the deployment environment.
3. Deploy the container on any service that supplies a `PORT` environment variable. `/healthz` is the health-check endpoint.

No API keys or persistent volume are required. Scaling the web service horizontally is safe because generation state and user credentials stay in the browser. Public Spaces can change or become unavailable; the Space ID is an environment setting, although a replacement must expose the same Gradio input and output shape or the browser adapter must be updated with it.

The default image Space is `WilliamQM/Qwen-Image-Edit-2509` — a duplicate of the official `Qwen/Qwen-Image-Edit-2509` with the ZeroGPU reservation lowered from 300s to 120s so jobs are admitted with less remaining quota (20-step image editing, prompt rewriting disabled). `WS_HF_IMAGE_SPACE` can point back at `black-forest-labs/FLUX.2-dev` (steps 30, guidance 4) or the fast distilled `black-forest-labs/FLUX.2-klein-4B` (steps 4, guidance 1). The Space allows up to 85 seconds for a job; actual quota usage depends on how long the GPU function runs.

The checked-in defaults are an inexpensive testing preset: a 512×512 image, four image-editing steps, ten TripoSplat steps with CFG disabled, and 32,768 Gaussians. For final-quality generations, set the image to 1024×1024 and use 20 TripoSplat steps, guidance 3, and 262,144 Gaussians. ZeroGPU checks that the declared reservation fits within the remaining quota before starting, then accounts for the GPU time used.

`Inference credits for FLUX` is off by default. When enabled in the editor settings, the FLUX image-detail step uses Hugging Face Inference Providers (fal) instead of ZeroGPU; a 512×512 four-step edit is typically about 1–2 cents. TripoSplat still uses ZeroGPU. WorldSketch never falls back to this paid route unless the setting is enabled.

## Security and quota behavior

- Sign-in uses OAuth Authorization Code with PKCE. The access token is stored in session storage for the current tab so the sign-in page can open the editor; it disappears when the tab is closed or the user signs out.
- WorldSketch asks for `openid profile inference-api`; it has no repository or account write permission. The inference permission can spend monthly inference credits only when `Use inference credits` is enabled.
- Prompt rewriting is disabled, so the image stage stays entirely on the selected Hugging Face Space.
- Jobs are not retried automatically because retries could consume GPU allowance twice.
- If a daily ZeroGPU allowance is exhausted, the app shows a plain-language error and leaves the build intact.
