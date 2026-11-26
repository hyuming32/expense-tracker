import { createWorker } from 'tesseract.js';
import { extractDrawNumbers, type ExtractDrawNumbersResult } from '../domain';

export interface OcrProgress {
  status: string;
  progress: number; // 0 ~ 1
}

export interface RecognizeDrawImageResult {
  rawText: string;
  draft: ExtractDrawNumbersResult;
}

const STATUS_LABELS: Record<string, string> = {
  'loading tesseract core': '載入辨識核心中',
  'initializing tesseract': '初始化辨識引擎',
  'loading language traineddata': '下載數字辨識資料中',
  'initializing api': '準備辨識環境',
  'recognizing text': '正在辨識截圖號碼',
};

export function formatOcrStatusLabel(status: string): string {
  return STATUS_LABELS[status] ?? '正在處理圖片';
}

/**
 * 在瀏覽器端使用 tesseract.js（eng + 數字白名單）辨識發票開獎截圖，不上傳任何圖片至伺服器。
 */
export async function recognizeLotteryScreenshot(
  image: File | Blob,
  onProgress?: (info: OcrProgress) => void,
): Promise<RecognizeDrawImageResult> {
  const worker = await createWorker('eng', 1, {
    logger: (message) => {
      onProgress?.({
        status: formatOcrStatusLabel(message.status),
        progress: typeof message.progress === 'number' ? message.progress : 0,
      });
    },
  });

  try {
    await worker.setParameters({
      tessedit_char_whitelist: '0123456789 \n-',
    });
    const {
      data: { text },
    } = await worker.recognize(image);
    return {
      rawText: text,
      draft: extractDrawNumbers(text),
    };
  } finally {
    await worker.terminate();
  }
}
