import {build} from 'esbuild';
import {mkdir,copyFile,readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
await mkdir('web/dist',{recursive:true});
await build({entryPoints:['web/src/main.jsx'],bundle:true,minify:true,format:'esm',target:['es2022'],outfile:'web/dist/app.js',loader:{'.woff2':'file'},define:{'process.env.NODE_ENV':'"production"'}});
await copyFile('web/src/app.css','web/dist/app.css');
try { await copyFile('web/src/wallpaper.webp','web/dist/wallpaper.webp'); } catch { /* wallpaper is optional (off by default); absence must not break the build */ }
try { await copyFile('web/src/wallpaper.jpg','web/dist/wallpaper.jpg'); } catch { /* wallpaper is optional; absence must not break the build */ }
let html=await readFile('web/src/index.html','utf8');
for(const name of ['app.js','app.css']){
  const digest=createHash('sha256').update(await readFile('web/dist/'+name)).digest('hex').slice(0,12);
  html=html.replace('/'+name,'/'+name+'?v='+digest);
}
await writeFile('web/dist/index.html',html);
console.log('SubHub web build complete');
