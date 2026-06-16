export async function downloadImageData({ imageDataUrl, filename }) {
  const response = await chrome.runtime.sendMessage({
    type: "downloadImageData",
    imageDataUrl,
    filename
  });

  if (!response || !response.ok) {
    throw {
      phase: "download",
      error: response && response.error ? response.error : "下载失败",
      diagnostics: { filename }
    };
  }

  return response.result;
}
