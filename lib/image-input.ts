/** Local-only decoding: no photograph is sent to a conversion service. */
export async function decodeExperimentImage(file: File): Promise<HTMLImageElement> {
  const load = (blob: Blob) => new Promise<HTMLImageElement>((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const image = new Image();
    image.onload = () => { URL.revokeObjectURL(url); resolve(image); };
    image.onerror = () => { URL.revokeObjectURL(url); reject(new Error("图片解码失败")); };
    image.src = url;
  });
  try { return await load(file); } catch {
    if (!/\.(heic|heif)$/i.test(file.name) && !/hei[cf]/i.test(file.type)) throw new Error("请使用 PNG、JPEG、WebP 或 HEIC 图片");
    const { heicTo } = await import("heic-to/csp");
    return load(await heicTo({ blob: file, type: "image/png" }));
  }
}
