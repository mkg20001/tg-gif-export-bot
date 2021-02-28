{ stdenv
, lib
, drvSrc ? ./.
, mkNode
, nodejs-14_x
, makeWrapper
, zlib
, libpng
, pkg-config
, optipng
, chromium
, ffmpeg
}:

let
  extraPath = [
    ffmpeg
  ];
in
mkNode {
  root = drvSrc;
  nodejs = nodejs-14_x;
  production = false;
  packageLock = ./package-lock.json;
} {
  buildInputs = [
    chromium
  ] ++ extraPath;

  nativeBuildInputs = [
    makeWrapper
  ];

  prePatch = ''
    export PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=1
  '';

  postInstall = ''
    for bin in $out/bin/*; do
      wrapProgram $bin \
        --set PUPPETEER_EXECUTABLE_PATH ${chromium.outPath}/bin/chromium \
        --prefix PATH : ${lib.makeBinPath extraPath}
    done
  '';
}

