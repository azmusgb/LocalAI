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
