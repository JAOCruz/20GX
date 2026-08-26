const { execFileSync } = require('child_process');
const fs = require('fs');

function replaceAudio(inputFile, musicFile, outputFile) {
  if (!fs.existsSync(musicFile)) {
    throw new Error(`No se encontro la pista de musica: ${musicFile}`);
  }

  const args = [
    '-y',
    '-i', inputFile,
    '-stream_loop', '-1', '-i', musicFile,
    '-filter_complex',
    '[1:a]volume=0.12,afade=t=out:st=0:d=2[bg];[0:a]volume=1.0[game];[game][bg]amix=inputs=2:duration=first[aout]',
    '-map', '0:v:0',
    '-map', '[aout]',
    '-c:v', 'copy',
    '-c:a', 'aac',
    '-b:a', '192k',
    outputFile,
  ];

  execFileSync('ffmpeg', args, { stdio: 'inherit' });
  return outputFile;
}

module.exports = { replaceAudio };
