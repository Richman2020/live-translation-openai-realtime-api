param(
    [Parameter(Mandatory=$true)][string]$OutputDirectory
)
$ErrorActionPreference = 'Stop'
$workspaceRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$privateRoot = [IO.Path]::GetFullPath((Join-Path $workspaceRoot '.runtime'))
$outputPath = if ([IO.Path]::IsPathRooted($OutputDirectory)) { [IO.Path]::GetFullPath($OutputDirectory) } else { [IO.Path]::GetFullPath((Join-Path $workspaceRoot $OutputDirectory)) }
if (-not $outputPath.StartsWith($privateRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'OUTPUT_MUST_BE_INSIDE_RUNTIME' }
if (Test-Path -LiteralPath $outputPath) { throw 'OUTPUT_ALREADY_EXISTS' }
$checkPath = Split-Path -Parent $outputPath
while ($checkPath -and $checkPath.StartsWith($workspaceRoot, [StringComparison]::OrdinalIgnoreCase)) {
    if ((Test-Path -LiteralPath $checkPath) -and ((Get-Item -LiteralPath $checkPath -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'OUTPUT_REPARSE_POINT_FORBIDDEN' }
    $checkPath = Split-Path -Parent $checkPath
}
$fixturePath = Join-Path $workspaceRoot 'tests/fixtures/phone-quality-v1.json'
$fixture = Get-Content -LiteralPath $fixturePath -Raw -Encoding UTF8 | ConvertFrom-Json
if ($fixture.version -ne 'phone-quality-v1' -or $fixture.cases.Count -ne 14) { throw 'INVALID_FIXTURE' }
$ids = @{}
foreach ($item in $fixture.cases) {
    if ($item.id -notmatch '^(0[1-9]|1[0-2]|L0[12])$' -or $ids.ContainsKey($item.id) -or $item.sourceText.Length -lt 1 -or $item.sourceText.Length -gt 1200 -or $item.role -notin @('local','remote')) { throw 'INVALID_CASE' }
    $ids[$item.id] = $true
}
# Local synthetic fixtures only. Never reads .env, records a microphone, calls a
# provider or places a phone call. Run under Windows PowerShell 5.1.
Add-Type -AssemblyName System.Speech
Add-Type -TypeDefinition @'
using System;
using System.IO;
public static class PhoneQualityPcmu {
  public static byte[] ReadWave(string file) {
    byte[] wav=File.ReadAllBytes(file); bool valid=false; byte[] pcm=null;
    if(wav.Length<44 || System.Text.Encoding.ASCII.GetString(wav,0,4)!="RIFF" || System.Text.Encoding.ASCII.GetString(wav,8,4)!="WAVE") throw new Exception("INVALID_WAVE");
    for(int p=12;p+8<=wav.Length;) {
      string id=System.Text.Encoding.ASCII.GetString(wav,p,4); uint n=BitConverter.ToUInt32(wav,p+4); int start=p+8;
      if(n>int.MaxValue || n>wav.Length-start) throw new Exception("INVALID_WAVE_CHUNK");
      if(id=="fmt ") { if(n<16) throw new Exception("INVALID_WAVE_FORMAT"); valid=BitConverter.ToUInt16(wav,start)==1 && BitConverter.ToUInt16(wav,start+2)==1 && BitConverter.ToUInt32(wav,start+4)==8000 && BitConverter.ToUInt16(wav,start+14)==16; }
      if(id=="data") { if(pcm!=null) throw new Exception("DUPLICATE_WAVE_DATA"); pcm=new byte[(int)n]; Buffer.BlockCopy(wav,start,pcm,0,(int)n); }
      p=start+(int)n+((int)n%2);
    }
    if(!valid || pcm==null || pcm.Length==0 || pcm.Length%2!=0 || pcm.Length>60*16000) throw new Exception("INVALID_WAVE_AUDIO");
    byte[] output=new byte[pcm.Length/2];
    for(int i=0;i<output.Length;i++) { int v=BitConverter.ToInt16(pcm,i*2); int sign=v<0?128:0; int sample=Math.Min(32635,Math.Abs(v))+132; int exponent=7; for(int mask=16384;exponent>0 && (sample & mask)==0;exponent--,mask>>=1){} output[i]=(byte)(~(sign | (exponent<<4) | ((sample>>(exponent+3)) & 15)) & 255); }
    return output;
  }
}
'@
$speaker = New-Object System.Speech.Synthesis.SpeechSynthesizer
$format = [System.Speech.AudioFormat.SpeechAudioFormatInfo]::new(8000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
$utf8 = New-Object System.Text.UTF8Encoding($false)
try {
    # Validate both installed voices before creating any output.
    $speaker.SelectVoice('Microsoft Huihui Desktop')
    $speaker.SelectVoice('Microsoft Zira Desktop')
    New-Item -ItemType Directory -Path $outputPath -Force | Out-Null
    $cases = @()
    foreach ($item in $fixture.cases) {
        $voice = if ($item.role -eq 'local') { 'Microsoft Huihui Desktop' } else { 'Microsoft Zira Desktop' }
        $speaker.SelectVoice($voice)
        $wavPath = Join-Path $outputPath ($item.id + '.wav')
        $pcmuPath = Join-Path $outputPath ($item.id + '.pcmu')
        $speaker.SetOutputToWaveFile($wavPath, $format)
        $speaker.Speak($item.sourceText)
        $speaker.SetOutputToNull()
        $audio = [PhoneQualityPcmu]::ReadWave($wavPath)
        [IO.File]::WriteAllBytes($pcmuPath, $audio)
        $cases += [ordered]@{ id=$item.id; role=$item.role; inputFile=($item.id + '.pcmu'); sourceText=$item.sourceText; expectedTranslation=$item.expectedTranslation; targetLanguage=$item.targetLanguage; kind=$item.kind; syntheticVoice=$voice; inputSha256=(Get-FileHash -LiteralPath $pcmuPath -Algorithm SHA256).Hash.ToLowerInvariant() }
    }
    $manifest = [ordered]@{ version='phone-quality-inputs/1'; kind='synthetic'; format='PCMU_8000_mono'; fixtureVersion=$fixture.version; fixtureSha256=(Get-FileHash -LiteralPath $fixturePath -Algorithm SHA256).Hash.ToLowerInvariant(); cases=$cases }
    [IO.File]::WriteAllText((Join-Path $outputPath 'manifest.json'), ($manifest | ConvertTo-Json -Depth 8), $utf8)
    [ordered]@{ ready=$true; kind='synthetic'; caseCount=$cases.Count; providerCalls=0; microphoneRecorded=$false; manifest=(Join-Path $outputPath 'manifest.json') } | ConvertTo-Json -Compress
} finally {
    $speaker.Dispose()
}
