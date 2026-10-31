param(
    [string]$ComfyDir = 'C:\Projects\ComfyHost',
    [string]$Python = 'C:\Python312\python.exe',
    # fast = DreamShaper 8, quality = DreamShaper XL Lightning, best/zimage = Z-Image Turbo,
    # flux = legacy FLUX.1 schnell GGUF fallback, upscale = Real-ESRGAN.
    [ValidateSet('fast', 'quality', 'best', 'zimage', 'flux', 'upscale')]
    [string[]]$Engines = @('fast', 'quality', 'best', 'upscale')
)

# Downloads the open image models Local AI's Images page uses. "best" intentionally resolves to the same
# Z-Image Turbo profile the runtime advertises as Best. Use -Engines flux explicitly for the legacy FLUX fallback.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if (-not (Test-Path -LiteralPath $ComfyDir -PathType Container)) { throw "ComfyUI directory not found: $ComfyDir" }
if (-not (Test-Path -LiteralPath $Python -PathType Leaf)) { throw "Python executable not found: $Python" }

$models = Join-Path $ComfyDir 'models'
$zBase = 'https://huggingface.co/Comfy-Org/Z-Image-Turbo/resolve/main/split_files'
$files = @{
    fast    = @(@('checkpoints\DreamShaper_8_pruned.safetensors', 'https://huggingface.co/Lykon/DreamShaper/resolve/main/DreamShaper_8_pruned.safetensors'))
    quality = @(@('checkpoints\DreamShaperXL_Lightning.safetensors', 'https://huggingface.co/Lykon/dreamshaper-xl-lightning/resolve/main/DreamShaperXL_Lightning.safetensors'))
    zimage  = @(
        @('diffusion_models\z_image_turbo_bf16.safetensors', "$zBase/diffusion_models/z_image_turbo_bf16.safetensors"),
        @('text_encoders\qwen_3_4b.safetensors', "$zBase/text_encoders/qwen_3_4b.safetensors"),
        @('vae\ae.safetensors', "$zBase/vae/ae.safetensors")
    )
    flux    = @(
        @('unet\flux1-schnell-Q4_K_S.gguf', 'https://huggingface.co/city96/FLUX.1-schnell-gguf/resolve/main/flux1-schnell-Q4_K_S.gguf'),
        @('clip\t5xxl_fp8_e4m3fn.safetensors', 'https://huggingface.co/comfyanonymous/flux_text_encoders/resolve/main/t5xxl_fp8_e4m3fn.safetensors'),
        @('clip\clip_l.safetensors', 'https://huggingface.co/comfyanonymous/flux_text_encoders/resolve/main/clip_l.safetensors'),
        @('vae\flux_ae.safetensors', 'https://huggingface.co/ffxvs/vae-flux/resolve/main/ae.safetensors')
    )
    upscale = @(@('upscale_models\RealESRGAN_x4plus.pth', 'https://huggingface.co/lllyasviel/Annotators/resolve/main/RealESRGAN_x4plus.pth'))
}

$resolved = foreach ($engine in $Engines) { if ($engine -eq 'best') { 'zimage' } else { $engine } }
$resolved = @($resolved | Select-Object -Unique)

foreach ($engine in $resolved) {
    foreach ($f in $files[$engine]) {
        $dest = Join-Path $models $f[0]
        if (Test-Path -LiteralPath $dest -PathType Leaf) { "have  $($f[0])"; continue }
        New-Item -ItemType Directory -Force (Split-Path $dest) | Out-Null
        $part = "$dest.part"
        Remove-Item -LiteralPath $part -Force -ErrorAction SilentlyContinue
        "fetch $($f[0]) ..."
        & curl.exe -sSL --fail --retry 3 --retry-delay 2 -o $part $f[1]
        if ($LASTEXITCODE -ne 0) {
            Remove-Item -LiteralPath $part -Force -ErrorAction SilentlyContinue
            throw "Download failed ($LASTEXITCODE): $($f[1])"
        }
        if (-not (Test-Path -LiteralPath $part -PathType Leaf) -or (Get-Item -LiteralPath $part).Length -le 0) {
            Remove-Item -LiteralPath $part -Force -ErrorAction SilentlyContinue
            throw "Download produced an empty file: $($f[1])"
        }
        Move-Item -LiteralPath $part -Destination $dest -Force
        "done  $($f[0]) $([math]::Round((Get-Item -LiteralPath $dest).Length / 1GB, 2)) GB"
    }
}

if ($resolved -contains 'flux') {
    $node = Join-Path $ComfyDir 'custom_nodes\ComfyUI-GGUF'
    if (-not (Test-Path -LiteralPath $node -PathType Container)) {
        git clone -q --depth 1 https://github.com/city96/ComfyUI-GGUF $node
        if ($LASTEXITCODE -ne 0) { throw "Failed to clone ComfyUI-GGUF ($LASTEXITCODE)" }
    }
    & $Python -m pip install -q -r (Join-Path $node 'requirements.txt')
    if ($LASTEXITCODE -ne 0) { throw "Failed to install ComfyUI-GGUF requirements ($LASTEXITCODE)" }
    'ComfyUI-GGUF installed; restart the LocalAI ComfyUI task to load it.'
}

'Image model installation complete.'
