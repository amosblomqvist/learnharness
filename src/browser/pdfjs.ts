/**
 * pdf.js for the phone build. The desktop runs pdf.js's legacy build in
 * Node on a main-thread fake worker; a browser needs a real worker script.
 * scripts/build-mobile.mjs copies it to /app/pdf.worker.js and routes every
 * import of "pdfjs-dist/legacy/build/pdf.mjs" here, so it is configured
 * before any document opens.
 */
import { GlobalWorkerOptions } from "pdfjs-dist/legacy/build/pdf.mjs";

GlobalWorkerOptions.workerSrc = "/app/pdf.worker.js";

export * from "pdfjs-dist/legacy/build/pdf.mjs";
