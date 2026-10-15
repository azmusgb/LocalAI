param(
    [string]$ComfyDir = 'C:\Projects\ComfyHost',
    [string]$Python = 'C:\Python312\python.exe',
    # fast = DreamShaper 8 (2 GB), quality = DreamShaper XL Lightning (6.5 GB), best = FLUX.1 schnell GGUF (~11 GB), upscale = Real-ESRGAN (64 MB)
    [string[]]$Engines = @('fast', 'quality', 'best', 'upscale')
)
# Downloads the open image models Local AI's Images page uses, into ComfyUI's model folders, and installs the
# ComfyUI-GGUF node that FLUX needs. Re-running skips files that are already there. Restart the
# 'LocalAI ComfyUI' task afterwards so ComfyUI loads the new node.
$ErrorActionPreference = 'Stop'
$models = Join-Path $ComfyDir 'models'
$files = @{
    fast    = @(@('checkpoints\DreamShaper_8_pruned.safetensors', 'https://huggingface.co/Lykon/DreamShaper/resolve/main/DreamShaper_8_pruned.safetensors'))
    quality = @(@('checkpoints\DreamShaperXL_Lightning.safetensors', 'https://huggingface.co/Lykon/dreamshaper-xl-lightning/resolve/main/DreamShaperXL_Lightning.safetensors'))
    best    = @(
        @('unet\flux1-schnell-Q4_K_S.gguf', 'https://huggingface.co/city96/FLUX.1-schnell-gguf/resolve/main/flux1-schnell-Q4_K_S.gguf'),
        @('clip\t5xxl_fp8_e4m3fn.safetensors', 'https://huggingface.co/comfyanonymous/flux_text_encoders/resolve/main/t5xxl_fp8_e4m3fn.safetensors'),
        @('clip\clip_l.safetensors', 'https://huggingface.co/comfyanonymous/flux_text_encoders/resolve/main/clip_l.safetensors'),
        @('vae\flux_ae.safetensors', 'https://huggingface.co/ffxvs/vae-flux/resolve/main/ae.safetensors'))
    upscale = @(@('upscale_models\RealESRGAN_x4plus.pth', 'https://huggingface.co/lllyasviel/Annotators/resolve/main/RealESRGAN_x4plus.pth'))
}
foreach ($engine in $Engines) {
    foreach ($f in $files[$engine]) {
        $dest = Join-Path $models $f[0]
        if (Test-Path $dest) { "have  $($f[0])"; continue }
        New-Item -ItemType Directory -Force (Split-Path $dest) | Out-Null
        "fetch $($f[0]) ..."
        & curl.exe -sSL --fail --retry 3 -o "$dest.part" $f[1]
        if ($LASTEXITCODE -ne 0) { Remove-Item "$dest.part" -ErrorAction SilentlyContinue; throw "Download failed ($LASTEXITCODE): $($f[1])" }
        Move-Item "$dest.part" $dest -Force
        "done  $($f[0]) $([math]::Round((Get-Item $dest).Length / 1GB, 2)) GB"
    }
}
if ($Engines -contains 'best') {
    $node = Join-Path $ComfyDir 'custom_nodes\ComfyUI-GGUF'
    if (-not (Test-Path $node)) { git clone -q --depth 1 https://github.com/city96/ComfyUI-GGUF $node }
    & $Python -m pip install -q -r (Join-Path $node 'requirements.txt')
    'ComfyUI-GGUF installed; restart the LocalAI ComfyUI task to load it.'
}
