Add-Type -AssemblyName System.Drawing

# Envelope glyph (outline rect + flap chevron), matching the topbar icon in index.html —
# distinct from canvassing-tool's map-pin and price-watch's £ so all KML apps' home-screen
# icons are visually distinguishable at a glance.

function New-Icon($size, $path) {
  $bmp = New-Object System.Drawing.Bitmap($size, $size)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias

  $bg = [System.Drawing.ColorTranslator]::FromHtml("#1C3A2B")
  $fg = [System.Drawing.ColorTranslator]::FromHtml("#CDDC5C")

  $radius = [int]($size * 0.22)
  $bgPath = New-Object System.Drawing.Drawing2D.GraphicsPath
  $d = $radius * 2
  $bgPath.AddArc(0, 0, $d, $d, 180, 90)
  $bgPath.AddArc($size - $d, 0, $d, $d, 270, 90)
  $bgPath.AddArc($size - $d, $size - $d, $d, $d, 0, 90)
  $bgPath.AddArc(0, $size - $d, $d, $d, 90, 90)
  $bgPath.CloseFigure()
  $bgBrush = New-Object System.Drawing.SolidBrush($bg)
  $g.FillPath($bgBrush, $bgPath)

  $penW = [Math]::Max(2, [int]($size * 0.052))
  $pen = New-Object System.Drawing.Pen($fg, $penW)
  $pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
  $pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
  $pen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round

  $left = $size * 0.24
  $right = $size * 0.76
  $top = $size * 0.34
  $bottom = $size * 0.68
  $rectW = $right - $left
  $rectH = $bottom - $top
  $cornerR = $rectH * 0.18

  $envPath = New-Object System.Drawing.Drawing2D.GraphicsPath
  $cd = $cornerR * 2
  $envPath.AddArc($left, $top, $cd, $cd, 180, 90)
  $envPath.AddArc($right - $cd, $top, $cd, $cd, 270, 90)
  $envPath.AddArc($right - $cd, $bottom - $cd, $cd, $cd, 0, 90)
  $envPath.AddArc($left, $bottom - $cd, $cd, $cd, 90, 90)
  $envPath.CloseFigure()
  $g.DrawPath($pen, $envPath)

  $g.DrawLine($pen, $left + ($rectW * 0.04), $top + ($rectH * 0.08), $left + ($rectW * 0.5), $top + ($rectH * 0.62))
  $g.DrawLine($pen, $left + ($rectW * 0.5), $top + ($rectH * 0.62), $right - ($rectW * 0.04), $top + ($rectH * 0.08))

  $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose()
  $bmp.Dispose()
}

New-Icon 192 "C:\Users\jakem\projects\kml-marketing\icon-192.png"
New-Icon 512 "C:\Users\jakem\projects\kml-marketing\icon-512.png"
New-Icon 180 "C:\Users\jakem\projects\kml-marketing\apple-touch-icon.png"

Write-Host "Icons generated."
