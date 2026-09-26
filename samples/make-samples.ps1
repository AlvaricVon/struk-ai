<#
.SYNOPSIS
    Renders the sample receipts shipped in samples/ as PNG images.

.DESCRIPTION
    The repo needs receipt images to demo (and test) the OCR stage, and we can't
    just lift photos off the internet - licence unclear, and they'd bloat the
    repo. So we draw them instead: every pixel here is generated from text by
    System.Drawing, which means the samples are original work, tiny, and
    regenerable on any Windows box.

    Two flavours are produced on purpose:
      receipt-coffee.png   crisp, straight-on, easy to read
      receipt-market.png   tilted and softened, the way a phone photo of a
                           crumpled thermal roll actually looks - this is the one
                           that exercises the upscale-then-OCR path

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File samples/make-samples.ps1
#>
[CmdletBinding()]
param(
    [string]$OutputDir
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

# $PSScriptRoot is not populated when this runs via `-File` with a relative path,
# so fall back to the current directory.
if (-not $OutputDir) {
    $OutputDir = if ($PSScriptRoot) { $PSScriptRoot } else { $PWD.Path }
}

$script:CharWidth = 46  # monospace columns on the printed roll

function Format-Line {
    param([string]$Left, [string]$Right = '')
    if ($Right) { return $Left.PadRight($script:CharWidth - $Right.Length) + $Right }
    return $Left
}

function Center-Line {
    param([string]$Text)
    $pad = [Math]::Max(0, [Math]::Floor(($script:CharWidth - $Text.Length) / 2))
    return (' ' * $pad) + $Text
}

function Get-ReceiptLines {
    param([string]$Name)

    switch ($Name) {
        'coffee' {
            ,@(
                (Center-Line 'NORTHSIDE COFFEE')
                (Center-Line '824 ALDER STREET')
                (Center-Line 'PORTLAND OR 97205')
                (Format-Line ('-' * $script:CharWidth))
                (Format-Line 'Order A-2291' '12/03/2026 09:41')
                (Format-Line 'Cashier Rina' 'Register 2')
                (Format-Line ('-' * $script:CharWidth))
                (Format-Line 'QTY  ITEM' 'AMOUNT')
                (Format-Line '2     Iced Vanilla Latte' '13.00')
                (Format-Line '1     Butter Croissant' '6.50')
                (Format-Line '1     Sparkling Water' '3.25')
                (Format-Line '1     Dark Chocolate Bar' '4.75')
                (Format-Line ('-' * $script:CharWidth))
                (Format-Line 'Subtotal' '27.50')
                (Format-Line 'Tax 8.8%' '2.42')
                (Format-Line 'TOTAL' '29.92')
                (Format-Line ('-' * $script:CharWidth))
                (Format-Line 'VISA ****4412' '29.92')
                (Format-Line 'AUTH CODE 009213')
                (Format-Line 'Thank you for visiting!')
                ''
            )
        }
        'market' {
            ,@(
                (Center-Line 'GREENLEAF MARKET')
                (Center-Line '4400 SE Division St')
                (Center-Line 'Portland, OR 97206')
                (Format-Line ('-' * $script:CharWidth))
                (Format-Line 'Receipt 88213' '03/12/2026 17:26')
                (Format-Line 'Cashier 7' 'Lane 04')
                (Format-Line ('-' * $script:CharWidth))
                (Format-Line 'QTY  ITEM' 'AMOUNT')
                (Format-Line '1     Organic Bananas 1kg' '3.49')
                (Format-Line '2     Free Range Eggs' '8.99')
                (Format-Line '1     Whole Milk 1L' '4.29')
                (Format-Line '1     Sourdough Loaf' '6.50')
                (Format-Line '1     Cherry Tomatoes' '4.99')
                (Format-Line '1     Olive Oil 500ml' '11.99')
                (Format-Line '2     Ground Coffee 250g' '18.00')
                (Format-Line ('-' * $script:CharWidth))
                (Format-Line 'Subtotal' '58.25')
                (Format-Line 'Tax' '0.00')
                (Format-Line 'TOTAL' '58.25')
                (Format-Line ('-' * $script:CharWidth))
                (Format-Line 'VISA ****8890' '58.25')
                (Format-Line 'APPROVED')
                (Format-Line 'Items 9   Savings 4.20')
                ''
            )
        }
        default { throw "unknown receipt '$Name'" }
    }
}

function New-ReceiptImage {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][string]$Name,
        [switch]$Tilted
    )

    $lines = Get-ReceiptLines -Name $Name

    $font = New-Object System.Drawing.Font('Consolas', 21, [System.Drawing.FontStyle]::Regular)
    $bold = New-Object System.Drawing.Font('Consolas', 21, [System.Drawing.FontStyle]::Bold)
    $titleFont = New-Object System.Drawing.Font('Consolas', 24, [System.Drawing.FontStyle]::Bold)
    $brush = [System.Drawing.Brushes]::Black
    $paper = [System.Drawing.Color]::White
    $lineHeight = 30
    $marginX = 28
    $marginTop = 26

    # Monospace metrics: measure one cell so the roll is sized to the text.
    $probe = New-Object System.Drawing.Bitmap(8, 8)
    $probeG = [System.Drawing.Graphics]::FromImage($probe)
    $cell = $probeG.MeasureString('0', $font)
    $probeG.Dispose(); $probe.Dispose()
    $cellW = [int][Math]::Ceiling($cell.Width)

    $textW = $cellW * $script:CharWidth
    $imgW = $textW + ($marginX * 2)
    $imgH = ($marginTop * 2) + ($lineHeight * ($lines.Count + 1))

    # `Tilted` renders small then scales back up, which is a cheap way to get the
    # soft, slightly out-of-focus look of a real phone snap without shipping a photo.
    $scale = if ($Tilted) { 0.34 } else { 1.0 }
    $bmp = New-Object System.Drawing.Bitmap(
        [int]($imgW * $scale), [int]($imgH * $scale))
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.Clear($paper)
    $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
    $g.ScaleTransform($scale, $scale)

    if ($Tilted) {
        $g.TranslateTransform($imgW / 2, $imgH / 2)
        $g.RotateTransform(-2.2)
        $g.TranslateTransform(-$imgW / 2, -$imgH / 2)
    }

    $y = $marginTop
    for ($i = 0; $i -lt $lines.Count; $i++) {
        $text = $lines[$i]
        if (-not $text) { $y += $lineHeight; continue }

        $useFont = if ($i -le 2) { $titleFont } elseif ($text -match 'TOTAL') { $bold } else { $font }
        $g.DrawString($text, $useFont, $brush, $marginX, $y)
        $y += $lineHeight
    }

    # Receipt paper edge, so it reads as a thermal roll rather than a text file.
    $pen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(210, 210, 210), 2)
    $g.DrawRectangle($pen, 1, 1, ($imgW - 2), ($imgH - 2))
    $pen.Dispose()

    $g.Dispose()

    if ($Tilted) {
        # Scale the small render back up with a soft interpolator = blurry photo.
        $final = New-Object System.Drawing.Bitmap($imgW, $imgH)
        $fg = [System.Drawing.Graphics]::FromImage($final)
        $fg.Clear([System.Drawing.Color]::FromArgb(38, 40, 44))
        $fg.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $fg.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
        $fg.DrawImage($bmp, 0, 0, $imgW, $imgH)
        $fg.Dispose(); $bmp.Dispose(); $final.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)
    }
    else {
        $bmp.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)
        $bmp.Dispose()
    }

    $font.Dispose(); $bold.Dispose(); $titleFont.Dispose()

    $kb = [int]((Get-Item $Path).Length / 1KB)
    Write-Host ("  {0,-28} {1,5} x {2,-5} {3,4} KB" -f `
            (Split-Path $Path -Leaf), $imgW, $imgH, $kb)
}

New-Item -ItemType Directory -Path $OutputDir -Force | Out-Null
Write-Host 'Rendering sample receipts...'
New-ReceiptImage -Path (Join-Path $OutputDir 'receipt-coffee.png')  -Name 'coffee'
New-ReceiptImage -Path (Join-Path $OutputDir 'receipt-market.png') -Name 'market' -Tilted
Write-Host 'Done.'
