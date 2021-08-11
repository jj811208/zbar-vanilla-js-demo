
      // init
      let inst = null;
      let HEAP32 = new Int32Array();
      const clock_gettime = (clk_id, tp) => {
        const now = Date.now();
        HEAP32[tp >> 2] = (now / 1e3) | 0;
        HEAP32[(tp + 4) >> 2] = ((now % 1e3) * 1e3 * 1e3) | 0;
        return 0;
      };
      let lastGrowTimestamp = 0;
      const emscripten_notify_memory_growth = (idx) => {
        if (lastGrowTimestamp) {
          console.info(
            "zbar.wasm: Memory Grow: ",
            inst.memory.buffer.byteLength
          );
        }
        lastGrowTimestamp = Date.now();
        HEAP32 = new Int32Array(inst.memory.buffer);
      };
      const importObj = {
        env: {
          clock_gettime,
          emscripten_notify_memory_growth,
        },
      };
      async function fetchAndInstantiate(url) {
        const response = await fetch(url);
        const buffer = await response.arrayBuffer();
        const obj = await WebAssembly.instantiate(buffer, importObj);

        console.log(obj,123);
        return obj;
      }
      const instPromise = (async () => {
        const res = await fetchAndInstantiate("./zbar.wasm.bin");
        if (!res) {
          throw Error("WASM was not loaded");
        }
        inst = res.instance.exports;
        emscripten_notify_memory_growth(0);
        return inst;
      })();

      const getInstance = async () => {
        return await instPromise;
      };

      //init

      // modules
      class CppObject {
        constructor(ptr, inst) {
          this.ptr = ptr;
          this.inst = inst;
        }

        checkAlive() {
          if (this.ptr) return;
          throw Error("Call after destroyed");
        }

        getPointer() {
          this.checkAlive();
          return this.ptr;
        }
      }

      class TypePointer {
        constructor(ptr, buf) {
          this.ptr = ptr;
          this.ptr32 = ptr >> 2;
          this.buf = buf;
          this.HEAP8 = new Int8Array(buf);
          this.HEAPU32 = new Uint32Array(buf);
          this.HEAP32 = new Int32Array(buf);
        }
      }

      class SymbolPtr extends TypePointer {
        get type() {
          return this.HEAPU32[this.ptr32];
        }

        get data() {
          const len = this.HEAPU32[this.ptr32 + 2];
          const ptr = this.HEAPU32[this.ptr32 + 3];
          return Int8Array.from(this.HEAP8.subarray(ptr, ptr + len));
        }

        get points() {
          const len = this.HEAPU32[this.ptr32 + 5];
          const ptr = this.HEAPU32[this.ptr32 + 6];
          const ptr32 = ptr >> 2;
          const res = [];
          for (let i = 0; i < len; ++i) {
            const x = this.HEAP32[ptr32 + i * 2];
            const y = this.HEAP32[ptr32 + i * 2 + 1];
            res.push({ x, y });
          }
          return res;
        }

        get next() {
          const ptr = this.HEAPU32[this.ptr32 + 8];
          if (!ptr) return null;
          return new SymbolPtr(ptr, this.buf);
        }

        get time() {
          return this.HEAPU32[this.ptr32 + 10];
        }

        get cacheCount() {
          return this.HEAP32[this.ptr32 + 11];
        }

        get quality() {
          return this.HEAP32[this.ptr32 + 12];
        }
      }

      class SymbolSetPtr extends TypePointer {
        get head() {
          const ptr = this.HEAPU32[this.ptr32 + 2];
          if (!ptr) return null;
          return new SymbolPtr(ptr, this.buf);
        }
      }

      const ZBarSymbolType = {
        ZBAR_NONE: 0 /**< no symbol decoded */,
        ZBAR_PARTIAL: 1 /**< intermediate status */,
        ZBAR_EAN8: 8 /**< EAN-8 */,
        ZBAR_UPCE: 9 /**< UPC-E */,
        ZBAR_ISBN10: 10 /**< ISBN-10 (from EAN-13). @since 0.4 */,
        ZBAR_UPCA: 12 /**< UPC-A */,
        ZBAR_EAN13: 13 /**< EAN-13 */,
        ZBAR_ISBN13: 14 /**< ISBN-13 (from EAN-13). @since 0.4 */,
        ZBAR_I25: 25 /**< Interleaved 2 of 5. @since 0.4 */,
        ZBAR_CODE39: 39 /**< Code 39. @since 0.4 */,
        ZBAR_PDF417: 57 /**< PDF417. @since 0.6 */,
        ZBAR_QRCODE: 64 /**< QR Code. @since 0.10 */,
        ZBAR_CODE128: 128 /**< Code 128 */,
        ZBAR_SYMBOL: 0x00ff /**< mask for base symbol type */,
        ZBAR_ADDON2: 0x0200 /**< 2-digit add-on flag */,
        ZBAR_ADDON5: 0x0500 /**< 5-digit add-on flag */,
        ZBAR_ADDON: 0x0700 /**< add-on flag mask */,
      };

      class Symbol {
        constructor(ptr) {
          this.type = ptr.type;
          this.typeName = ZBarSymbolType[this.type];
          this.data = ptr.data;
          this.points = ptr.points;
          this.time = ptr.time;
          this.cacheCount = ptr.cacheCount;
          this.quality = ptr.quality;
        }

        static createSymbolsFromPtr(ptr, buf) {
          if (ptr == 0) return [];

          const set = new SymbolSetPtr(ptr, buf);
          let symbol = set.head;
          const res = [];
          while (symbol !== null) {
            res.push(new Symbol(symbol));
            symbol = symbol.next;
          }
          return res;
        }

        decode(encoding) {
          const decoder = new TextDecoder(encoding);
          return decoder.decode(this.data);
        }
      }

      class Image extends CppObject {
        static async createFromGrayBuffer(
          width,
          height,
          dataBuf,
          sequence_num = 0
        ) {
          const inst = await getInstance();
          const heap = new Uint8Array(inst.memory.buffer);
          const data = new Uint8Array(dataBuf);
          const len = width * height;
          if (len !== data.byteLength) {
            throw Error("dataBuf does not match width and height");
          }
          const buf = inst.malloc(len);
          heap.set(data, buf);
          const ptr = inst.Image_create(
            width,
            height,
            0x30303859 /* Y800 */,
            buf,
            len,
            sequence_num
          );
          return new this(ptr, inst);
        }

        static async createFromRGBABuffer(
          width,
          height,
          dataBuf,
          sequence_num = 0
        ) {
          const inst = await getInstance();
          const heap = new Uint8Array(inst.memory.buffer);
          const data = new Uint8Array(dataBuf);
          const len = width * height;
          if (len * 4 !== data.byteLength) {
            throw Error("dataBuf does not match width and height");
          }
          const buf = inst.malloc(len);
          for (let i = 0; i < len; ++i) {
            const r = data[i * 4];
            const g = data[i * 4 + 1];
            const b = data[i * 4 + 2];
            heap[buf + i] = (r * 19595 + g * 38469 + b * 7472) >> 16;
          }
          const ptr = inst.Image_create(
            width,
            height,
            0x30303859 /* Y800 */,
            buf,
            len,
            sequence_num
          );
          return new this(ptr, inst);
        }

        destroy() {
          this.checkAlive();
          this.inst.Image_destory(this.ptr);
          this.ptr = 0;
        }

        getSymbols() {
          this.checkAlive();
          const res = this.inst.Image_get_symbols(this.ptr);
          return Symbol.createSymbolsFromPtr(res, this.inst.memory.buffer);
        }
      }

      class ImageScanner extends CppObject {
        static async create() {
          const inst = await getInstance();
          const ptr = inst.ImageScanner_create();
          return new this(ptr, inst);
        }

        destroy() {
          this.checkAlive();
          this.inst.ImageScanner_destory(this.ptr);
          this.ptr = 0;
        }

        setConfig(sym, conf, value) {
          this.checkAlive();
          return this.inst.ImageScanner_set_config(this.ptr, sym, conf, value);
        }

        enableCache(enable = true) {
          this.checkAlive();
          this.inst.ImageScanner_enable_cache(this.ptr, enable);
        }

        recycleImage(image) {
          this.checkAlive();
          this.inst.ImageScanner_recycle_image(this.ptr, image.getPointer());
        }

        getResults() {
          this.checkAlive();
          const res = this.inst.ImageScanner_get_results(this.ptr);
          return Symbol.createSymbolsFromPtr(res, this.inst.memory.buffer);
        }

        scan(image) {
          this.checkAlive();
          return this.inst.ImageScanner_scan(this.ptr, image.getPointer());
        }
      }

      const defaultScannerPromise = ImageScanner.create();

      const getDefaultScanner = async () => {
        return await defaultScannerPromise;
      };

      const scanImage = async (image, scanner) => {
        if (scanner === undefined) {
          scanner = await defaultScannerPromise;
        }
        const res = scanner.scan(image);
        if (res < 0) {
          throw Error("Scan Failed");
        }
        if (res === 0) return [];
        return image.getSymbols();
      };

      const scanGrayBuffer = async (buffer, width, height, scanner) => {
        const image = await Image.createFromGrayBuffer(width, height, buffer);
        const res = await scanImage(image, scanner);
        image.destroy();
        return res;
      };

      const scanRGBABuffer = async (buffer, width, height, scanner) => {
        const image = await Image.createFromRGBABuffer(width, height, buffer);
        const res = await scanImage(image, scanner);
        image.destroy();
        return res;
      };

      const scanImageData = async (image, scanner) => {
        return await scanRGBABuffer(
          image.data.buffer,
          image.width,
          image.height,
          scanner
        );
      };

      // modules
      getInstance().then((inst) => {
        const SCAN_PROID_MS = 800;

        const handleResize = () => {
          const width = document.documentElement.clientWidth;
          const height = document.documentElement.clientHeight;
          const video = document.getElementById("video");
          video.width = width;
          video.height = height;

          const canvas = document.getElementById("canvas");
          canvas.width = video.videoWidth;
          canvas.height = video.videoHeight;
          if (width / video.videoWidth < height / video.videoHeight) {
            canvas.style.width = "100vw";
            canvas.style.height = "auto";
          } else {
            canvas.style.width = "auto";
            canvas.style.height = "100vh";
          }
        };

        const init = async () => {
          window.onresize = handleResize;
          const mediaStream = await navigator.mediaDevices.getUserMedia({
            audio: false,
            video: {
              facingMode: "environment",
              width: { max: 640 },
              height: { max: 640 },
            },
          });
          const video = document.getElementById("video");
          video.srcObject = mediaStream;
          video.setAttribute("playsinline", "");
          video.play();
          await new Promise((r) => {
            video.onloadedmetadata = r;
          });
          handleResize();
        };

        const render = (symbols) => {
          const canvas = document.getElementById("canvas");
          const footer = document.getElementById("footer");
          const ctx = canvas.getContext("2d");
          const width = canvas.width;
          const height = canvas.height;
          ctx.clearRect(0, 0, width, height);
          while (footer.firstChild) {
            footer.removeChild(footer.lastChild);
          }
          ctx.font = "20px serif";
          ctx.strokeStyle = "#00ff00";
          ctx.fillStyle = "#ff0000";
          ctx.lineWidth = 6;
          for (let i = 0; i < symbols.length; ++i) {
            const sym = symbols[i];
            const points = sym.points;
            ctx.beginPath();
            for (let j = 0; j < points.length; ++j) {
              const { x, y } = points[j];
              if (j === 0) {
                ctx.moveTo(x, y);
              } else {
                ctx.lineTo(x, y);
              }
            }
            ctx.closePath();
            ctx.stroke();
            ctx.fillText("#" + i, points[0].x, points[0].y - 10);

            const div = document.createElement("div");
            div.className = "footerItem";
            div.innerText = `#${i}: Type: ${
              sym.typeName
            }; Value: "${sym.decode()}"`;
            footer.appendChild(div);
          }
        };

        const scan = async () => {
          const canvas = document.createElement("canvas");
          const video = document.getElementById("video");
          const width = video.videoWidth;
          const height = video.videoHeight;
          canvas.width = width;
          canvas.height = height;
          const ctx = canvas.getContext("2d");
          ctx.drawImage(video, 0, 0, width, height);
          const imgData = ctx.getImageData(0, 0, width, height);
          const res = await scanImageData(imgData);
          // console.log(res, Date.now());
          render(res);
        };

        const sleep = (ms) =>
          new Promise((r) => {
            setTimeout(r, ms);
          });

        const main = async () => {
          try {
            await init();
            while (true) {
              await scan();
              await sleep(SCAN_PROID_MS);
            }
          } catch (err) {
            const div = document.createElement("div");
            div.className = "full middle";
            div.style =
              "height: 72px; width: 100%; text-align: center; font-size: 36px";
            div.innerText = "Cannot get cammera: " + err;
            document.body.appendChild(div);
            console.error(err);
          }
        };

        main();
      });