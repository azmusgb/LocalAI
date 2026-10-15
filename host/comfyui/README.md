# ComfyUI (image generation)

LocalAI generates images through ComfyUI running on the Windows host (`C:\Projects\ComfyHost`, system Python
`C:\Python312` with CUDA PyTorch). The appliance container reaches it at `http://host.docker.internal:8188`
(`COMFY_URL`).

`Install-ComfyUI-Task.ps1` registers the `LocalAI ComfyUI` scheduled task: it starts ComfyUI at logon, restarts it if
it exits, and waits for `/system_stats` before reporting success. ComfyUI listens on `127.0.0.1` only; Docker Desktop
forwards `host.docker.internal` to the host's localhost, so the appliance can use it while nothing else on the
network can.

```powershell
C:\LocalAI\repo\host\comfyui\Install-ComfyUI-Task.ps1            # install / restart
C:\LocalAI\repo\host\comfyui\Install-ComfyUI-Task.ps1 -Uninstall # remove
```

If Images shows *Image generation is down*, check the task is running and see `C:\Projects\ComfyHost\user\comfyui_8188.log`.

## Image engines

The Images page offers up to three engines, depending on which models are installed. All are open models.

| Engine | Model | Size | Time on the GTX 1660 SUPER (6 GB) |
|---|---|---|---|
| Fast | DreamShaper 8 (SD 1.5 fine-tune), 512 px, 25 steps | 2 GB | ~16 s |
| Quality | DreamShaper XL Lightning (SDXL), 1024 px, 6 steps | 6.5 GB | ~55 s |
| Best | FLUX.1 schnell, GGUF Q4_K_S, 1024 px, 4 steps; best prompt-following, can draw text | ~11 GB | ~3 min |

"Sharpen and upscale 2×" uses Real-ESRGAN (64 MB, about +3 s). GTX 16-series cards run these models in fp32,
which is why SDXL and FLUX are slower here than on newer cards.

```powershell
.\host\comfyui\Install-ImageModels.ps1                  # all engines and the upscaler
.\host\comfyui\Install-ImageModels.ps1 -Engines fast    # just one
Restart-ScheduledTask 'LocalAI ComfyUI'                 # (Stop-, then Start-ScheduledTask) to load ComfyUI-GGUF for FLUX
```

Engine definitions, sizes and the ComfyUI graphs are in `app/image-engines.js`.
