# WorldSketch

WorldSketch turns a browser-built block-out into a detailed image with the official four-step FLUX.2 Klein 4B Space, then converts that image into a Gaussian splat with TripoSplat. Both models run through public Hugging Face Spaces using the signed-in user's own GPU allowance. The WorldSketch server never receives or stores the user's Hugging Face token, source image, generated image, or splat.

## Run locally

Requirements: Go 1.23+ and a modern browser.

```sh
cp .env.example .env
cd server
go run .
```

Open `http://localhost:8067/`. The included public OAuth client is already registered for that exact local URL.

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

The default image Space is the official `black-forest-labs/FLUX.2-klein-4B`. WorldSketch uses its distilled four-step image-editing mode at 512×512 with prompt upsampling disabled. The Space allows up to 85 seconds for a job; actual quota usage depends on how long the GPU function runs.

The checked-in defaults are an inexpensive testing preset: a 512×512 image, four image-editing steps, ten TripoSplat steps with CFG disabled, and 32,768 Gaussians. For final-quality generations, set the image to 1024×1024 and use 20 TripoSplat steps, guidance 3, and 262,144 Gaussians. ZeroGPU checks that the declared reservation fits within the remaining quota before starting, then accounts for the GPU time used.

## Security and quota behavior

- Sign-in uses OAuth Authorization Code with PKCE. The access token is kept only in JavaScript memory and disappears on refresh or tab close.
- WorldSketch asks only for `openid profile`; it has no write permission to the user's Hugging Face account.
- Prompt rewriting is disabled, so the image stage stays entirely on the selected Hugging Face Space.
- Jobs are not retried automatically because retries could consume GPU allowance twice.
- If a daily ZeroGPU allowance is exhausted, the app shows a plain-language error and leaves the build intact.
