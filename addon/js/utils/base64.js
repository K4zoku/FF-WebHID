(function () {
  if (typeof Uint8Array === "undefined") return;
  if (
    typeof Uint8Array.fromBase64 === "function" &&
    typeof Uint8Array.prototype.toBase64 === "function"
  )
    return;

  var commonAlphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  var base64Alphabet = commonAlphabet + "+/";
  var base64UrlAlphabet = commonAlphabet + "-_";

  function inverse(characters) {
    var result = {};
    var index = 0;
    for (; index < 64; index++) result[characters.charAt(index)] = index;
    return result;
  }

  var c2i = inverse(base64Alphabet);
  var c2iUrl = inverse(base64UrlAlphabet);
  var i2c = base64Alphabet;
  var i2cUrl = base64UrlAlphabet;

  function getAlphabetOption(options) {
    var alphabet = options && options.alphabet;
    if (alphabet === undefined || alphabet === "base64" || alphabet === "base64url")
      return alphabet || "base64";
    throw new TypeError("Incorrect `alphabet` option");
  }

  var hasOwn = Function.prototype.call.bind(
    Object.prototype.hasOwnProperty,
  );

  var skipAsciiWhitespace = function (string, index) {
    var length = string.length;
    for (; index < length; index++) {
      var chr = string.charAt(index);
      if (chr !== " " && chr !== "\t" && chr !== "\n" && chr !== "\f" && chr !== "\r")
        break;
    }
    return index;
  };

  var decodeBase64Chunk = function (chunk, alphabet, throwOnExtraBits) {
    var chunkLength = chunk.length;

    if (chunkLength < 4) {
      chunk += chunkLength === 2 ? "AA" : "A";
    }

    var triplet =
      (alphabet[chunk.charAt(0)] << 18) +
      (alphabet[chunk.charAt(1)] << 12) +
      (alphabet[chunk.charAt(2)] << 6) +
      alphabet[chunk.charAt(3)];

    var chunkBytes = [
      (triplet >> 16) & 255,
      (triplet >> 8) & 255,
      triplet & 255,
    ];

    if (chunkLength === 2) {
      if (throwOnExtraBits && chunkBytes[1] !== 0) {
        throw new SyntaxError("Extra bits");
      }
      return [chunkBytes[0]];
    }

    if (chunkLength === 3) {
      if (throwOnExtraBits && chunkBytes[2] !== 0) {
        throw new SyntaxError("Extra bits");
      }
      return [chunkBytes[0], chunkBytes[1]];
    }

    return chunkBytes;
  };

  var writeBytes = function (bytes, elements, written) {
    var elementsLength = elements.length;
    for (var index = 0; index < elementsLength; index++) {
      bytes[written + index] = elements[index];
    }
    return written + elementsLength;
  };

  var $fromBase64 = function (string, options, into, maxLength) {
    if (typeof string !== "string")
      throw new TypeError("Argument is not a string");

    if (options !== undefined && (typeof options !== "object" || options === null)) {
      throw new TypeError(options + " is not an object or undefined");
    }

    var alphabet = getAlphabetOption(options) === "base64" ? c2i : c2iUrl;
    var lastChunkHandling = options ? options.lastChunkHandling : undefined;

    if (lastChunkHandling === undefined) lastChunkHandling = "loose";

    if (
      lastChunkHandling !== "loose" &&
      lastChunkHandling !== "strict" &&
      lastChunkHandling !== "stop-before-partial"
    ) {
      throw new TypeError("Incorrect `lastChunkHandling` option");
    }

    var stringLength = string.length;
    var bytes = into || [];
    var written = 0;
    var read = 0;
    var chunk = "";
    var index = 0;

    if (maxLength)
      while (true) {
        index = skipAsciiWhitespace(string, index);
        if (index === stringLength) {
          if (chunk.length > 0) {
            if (lastChunkHandling === "stop-before-partial") {
              break;
            }
            if (lastChunkHandling === "loose") {
              if (chunk.length === 1) {
                throw new SyntaxError(
                  "Malformed padding: exactly one additional character",
                );
              }
              written = writeBytes(
                bytes,
                decodeBase64Chunk(chunk, alphabet, false),
                written,
              );
            } else {
              throw new SyntaxError("Missing padding");
            }
          }
          read = stringLength;
          break;
        }
        var chr = string.charAt(index);
        ++index;
        if (chr === "=") {
          if (chunk.length < 2) {
            throw new SyntaxError("Padding is too early");
          }
          index = skipAsciiWhitespace(string, index);
          if (chunk.length === 2) {
            if (index === stringLength) {
              if (lastChunkHandling === "stop-before-partial") {
                break;
              }
              throw new SyntaxError("Malformed padding: only one =");
            }
            if (string.charAt(index) === "=") {
              ++index;
              index = skipAsciiWhitespace(string, index);
            }
          }
          if (index < stringLength) {
            throw new SyntaxError("Unexpected character after padding");
          }
          written = writeBytes(
            bytes,
            decodeBase64Chunk(chunk, alphabet, lastChunkHandling === "strict"),
            written,
          );
          read = stringLength;
          break;
        }
        if (!hasOwn(alphabet, chr)) {
          throw new SyntaxError("Unexpected character");
        }
        var remainingBytes = maxLength - written;
        if (
          (remainingBytes === 1 && chunk.length === 2) ||
          (remainingBytes === 2 && chunk.length === 3)
        ) {
          break;
        }

        chunk += chr;
        if (chunk.length === 4) {
          written = writeBytes(
            bytes,
            decodeBase64Chunk(chunk, alphabet, false),
            written,
          );
          chunk = "";
          read = index;
          if (written === maxLength) {
            break;
          }
        }
      }

    return { bytes: bytes, read: read, written: written };
  };

  if (typeof Uint8Array.fromBase64 !== "function") {
    Object.defineProperty(Uint8Array, "fromBase64", {
      value: function fromBase64(string) {
        var result = $fromBase64(
          string,
          arguments.length > 1 ? arguments[1] : undefined,
          null,
          0x1fffffffffffff,
        );
        return new Uint8Array(result.bytes);
      },
      writable: true,
      configurable: true,
      enumerable: false,
    });
  }

  if (typeof Uint8Array.prototype.toBase64 !== "function") {
    Object.defineProperty(Uint8Array.prototype, "toBase64", {
      value: function toBase64() {
        var O = this;

        if (
          Object.prototype.toString.call(O).slice(8, -1) !== "Uint8Array"
        ) {
          throw new TypeError("Argument is not an Uint8Array");
        }

        var options = arguments.length ? arguments[0] : undefined;
        if (
          options !== undefined &&
          (typeof options !== "object" || options === null)
        ) {
          throw new TypeError(options + " is not an object or undefined");
        }

        var alphabet = getAlphabetOption(options);
        var omitPadding = !!(options && options.omitPadding);

        if (O.buffer) {
          try {
            new Uint8Array(O.buffer);
          } catch (e) {
            throw new TypeError("ArrayBuffer is detached");
          }
        }

        var lookup = alphabet === "base64" ? i2c : i2cUrl;

        var result = "";
        var i = 0;
        var length = O.length;
        var triplet;

        var charAtLookup = function (shift) {
          return lookup.charAt((triplet >> (6 * shift)) & 63);
        };

        for (; i + 2 < length; i += 3) {
          triplet = (O[i] << 16) + (O[i + 1] << 8) + O[i + 2];
          result +=
            charAtLookup(3) +
            charAtLookup(2) +
            charAtLookup(1) +
            charAtLookup(0);
        }
        if (i + 2 === length) {
          triplet = (O[i] << 16) + (O[i + 1] << 8);
          result +=
            charAtLookup(3) +
            charAtLookup(2) +
            charAtLookup(1) +
            (omitPadding ? "" : "=");
        } else if (i + 1 === length) {
          triplet = O[i] << 16;
          result +=
            charAtLookup(3) + charAtLookup(2) + (omitPadding ? "" : "==");
        }

        return result;
      },
      writable: true,
      configurable: true,
      enumerable: false,
    });
  }
})();
