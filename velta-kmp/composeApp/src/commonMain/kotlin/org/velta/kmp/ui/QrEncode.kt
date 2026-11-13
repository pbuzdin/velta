package org.velta.kmp.ui

import kotlin.math.abs
import kotlin.math.ceil
import kotlin.math.pow

/**
 * Port of app/js/qr-encode.js (Project Nayuki's QR Code generator, MIT —
 * the same algorithm the chatmail core's qrcodegen crate uses): optimal-mode
 * segmentation (numeric/alphanumeric/byte runs), ECC boost when bits are
 * free, penalty-based automatic mask. Only the surface the QR view needs is
 * exposed: encode(text) → size + get(x,y).
 */
object QrEncode {

    class Qr internal constructor(val version: Int, val size: Int, private val mod: Array<BooleanArray>) {
        /** Dark module at (x, y); false outside the symbol. */
        operator fun get(x: Int, y: Int): Boolean =
            x >= 0 && y >= 0 && x < size && y < size && mod[y][x]
    }

    // Ecc ordinals + format bits (web Ecc).
    private val ECC_LOW = intArrayOf(0, 1)
    private val ECC_MEDIUM = intArrayOf(1, 0)
    private val ECC_QUARTILE = intArrayOf(2, 3)
    private val ECC_HIGH = intArrayOf(3, 2)

    private const val ALNUM = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ \$%*+-./:"

    // mode → { data-encoding bits, char-count widths for versions 1-9 / 10-26 / 27-40 }
    private const val MODE_NUMERIC = 0
    private const val MODE_ALNUM = 1
    private const val MODE_BYTE = 2
    private val MODE_BITS = intArrayOf(0x1, 0x2, 0x4)
    private val MODE_CC = arrayOf(intArrayOf(10, 12, 14), intArrayOf(9, 11, 13), intArrayOf(8, 16, 16))
    // Web MODES = [byte, alnum, numeric] — the DP's cost columns run in this order.
    private val MODES = intArrayOf(MODE_BYTE, MODE_ALNUM, MODE_NUMERIC)

    private fun ccBits(mode: Int, ver: Int): Int = MODE_CC[mode][if (ver <= 9) 0 else if (ver <= 26) 1 else 2]

    // Web ECC_PER_BLOCK / NUM_BLOCKS: [ordinal][version], version 0 unused.
    private val ECC_PER_BLOCK = arrayOf(
        intArrayOf(-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30),
        intArrayOf(-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28),
        intArrayOf(-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30),
        intArrayOf(-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30),
    )
    private val NUM_BLOCKS = arrayOf(
        intArrayOf(-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25),
        intArrayOf(-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49),
        intArrayOf(-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68),
        intArrayOf(-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81),
    )

    private fun isNum(c: Char): Boolean = c in '0'..'9'
    private fun isAlnum(c: Char): Boolean = ALNUM.indexOf(c) >= 0

    private fun push(bits: ArrayList<Int>, value: Int, len: Int) {
        for (i in len - 1 downTo 0) bits.add((value ushr i) and 1)
    }

    private class Seg(val mode: Int, val numChars: Int, val data: List<Int>)

    private fun makeSeg(mode: Int, text: String): Seg {
        val data = ArrayList<Int>()
        when (mode) {
            MODE_NUMERIC -> {
                var i = 0
                while (i < text.length) {
                    val n = minOf(3, text.length - i)
                    push(data, text.substring(i, i + n).toInt(), n * 3 + 1)
                    i += 3
                }
            }
            MODE_ALNUM -> {
                var i = 0
                while (i + 1 < text.length) {
                    push(data, ALNUM.indexOf(text[i]) * 45 + ALNUM.indexOf(text[i + 1]), 11)
                    i += 2
                }
                if (i < text.length) push(data, ALNUM.indexOf(text[i]), 6)
            }
            else -> {
                val bytes = text.encodeToByteArray()
                for (b in bytes) push(data, b.toInt() and 0xff, 8)
                // numChars for byte mode = BYTE count (the decoder consumes
                // this many bytes), not the UTF-16 length.
                return Seg(mode, bytes.size, data)
            }
        }
        return Seg(mode, text.length, data)
    }

    /** Web [...text] iterates code points, not UTF-16 units — astral chars
     * count as ONE cost step and one numChars unit. */
    private fun codePoints(s: String): List<String> {
        val out = ArrayList<String>(s.length)
        var i = 0
        while (i < s.length) {
            val c = s[i]
            if (c.isHighSurrogate() && i + 1 < s.length && s[i + 1].isLowSurrogate()) {
                out.add(s.substring(i, i + 2))
                i += 2
            } else {
                out.add(c.toString())
                i += 1
            }
        }
        return out
    }

    /** What the core does (qrcodegen encode_text): one mode for the whole text. */
    private fun makeSegmentsSimple(text: String): List<Seg> {
        if (text.isEmpty()) return emptyList()
        val cps = codePoints(text)
        return when {
            cps.all { it.length == 1 && isNum(it[0]) } -> listOf(makeSeg(MODE_NUMERIC, text))
            cps.all { it.length == 1 && isAlnum(it[0]) } -> listOf(makeSeg(MODE_ALNUM, text))
            else -> listOf(makeSeg(MODE_BYTE, text))
        }
    }

    private fun totalBits(segs: List<Seg>, ver: Int): Double {
        var n = 0.0
        for (s in segs) {
            val cc = ccBits(s.mode, ver)
            if (s.numChars >= (1 shl cc)) return Double.POSITIVE_INFINITY
            n += 4 + cc + s.data.size
        }
        return n
    }

    /** Optimal segmentation for one version's char-count widths (costs in 1/6 bit). */
    private fun makeSegmentsForVersion(text: String, ver: Int): List<Seg> {
        val cps = codePoints(text)
        if (cps.isEmpty()) return emptyList()
        val head = MODES.map { (4 + ccBits(it, ver)) * 6.0 }.toDoubleArray()
        var prev = head.copyOf()
        val charModes = ArrayList<Array<Int?>>(cps.size)
        for (c in cps) {
            val cur = doubleArrayOf(Double.POSITIVE_INFINITY, Double.POSITIVE_INFINITY, Double.POSITIVE_INFINITY)
            val cm = arrayOfNulls<Int>(3)
            cur[0] = prev[0] + c.encodeToByteArray().size * 8 * 6
            cm[0] = MODES[0]
            val ch = if (c.length == 1) c[0] else ' '
            if (c.length == 1 && isAlnum(ch)) {
                cur[1] = prev[1] + 33
                cm[1] = MODES[1]
            }
            if (c.length == 1 && isNum(ch)) {
                cur[2] = prev[2] + 20
                cm[2] = MODES[2]
            }
            for (j in 0 until 3) {
                for (k in 0 until 3) {
                    val cost = ceil(cur[k] / 6) * 6 + head[j]
                    if (cm[k] != null && (cm[j] == null || cost < cur[j])) {
                        cur[j] = cost
                        cm[j] = cm[k]
                    }
                }
            }
            charModes.add(cm)
            prev = cur
        }
        var curIdx = prev.indices.minByOrNull { prev[it] } ?: 0
        val modes = arrayOfNulls<Int>(cps.size)
        for (i in cps.indices.reversed()) {
            val m = charModes[i][curIdx]
            modes[i] = m
            curIdx = MODES.indexOf(m!!)
        }
        val segs = ArrayList<Seg>()
        var start = 0
        for (i in 1..cps.size) {
            if (i == cps.size || modes[i] != modes[start]) {
                segs.add(makeSeg(modes[start]!!, cps.subList(start, i).joinToString("")))
                start = i
            }
        }
        return segs
    }

    private fun rawModules(ver: Int): Int {
        var r = (16 * ver + 128) * ver + 64
        if (ver >= 2) {
            val na = ver / 7 + 2
            r -= (25 * na - 10) * na - 55
            if (ver >= 7) r -= 36
        }
        return r
    }

    private fun dataCodewords(ver: Int, ecl: IntArray): Int =
        rawModules(ver) / 8 - ECC_PER_BLOCK[ecl[0]][ver] * NUM_BLOCKS[ecl[0]][ver]

    private fun rsMul(x: Int, y: Int): Int {
        var z = 0
        for (i in 7 downTo 0) {
            // Mask ONLY at the end: the >>> 7 must see the unmasked value's
            // high bits, exactly as the JS does (z & 0xff lives on return).
            z = (z shl 1) xor ((z ushr 7) * 0x11d)
            z = z xor (((y ushr i) and 1) * x)
        }
        return z and 0xff
    }

    private fun rsDivisor(deg: Int): IntArray {
        val r = IntArray(deg)
        r[deg - 1] = 1
        var root = 1
        for (i in 0 until deg) {
            for (j in 0 until deg) {
                r[j] = rsMul(r[j], root)
                if (j + 1 < deg) r[j] = r[j] xor r[j + 1]
            }
            root = rsMul(root, 2)
        }
        return r
    }

    private fun rsRemainder(data: List<Int>, div: IntArray): IntArray {
        val r = IntArray(div.size)
        for (b in data) {
            val f = b xor r[0]
            System.arraycopy(r, 1, r, 0, r.size - 1)
            r[r.size - 1] = 0
            for (i in div.indices) r[i] = r[i] xor rsMul(div[i], f)
        }
        return r
    }

    private val MASKS: Array<(Int, Int) -> Boolean> = arrayOf(
        { x, y -> (x + y) % 2 == 0 },
        { _, y -> y % 2 == 0 },
        { x, _ -> x % 3 == 0 },
        { x, y -> (x + y) % 3 == 0 },
        { x, y -> (x / 3 + y / 2) % 2 == 0 },
        { x, y -> (x * y) % 2 + (x * y) % 3 == 0 },
        { x, y -> ((x * y) % 2 + (x * y) % 3) % 2 == 0 },
        { x, y -> ((x + y) % 2 + (x * y) % 3) % 2 == 0 },
    )

    private class Matrix(val mod: Array<BooleanArray>, val fn: Array<BooleanArray>, val size: Int) {
        fun set(x: Int, y: Int, d: Boolean) {
            mod[y][x] = d
            fn[y][x] = true
        }
    }

    private fun buildMatrix(ver: Int, ecl: IntArray, codewords: List<Int>, maskIn: Int): Pair<Array<BooleanArray>, Int> {
        val size = ver * 4 + 17
        val mod = Array(size) { BooleanArray(size) }
        val fn = Array(size) { BooleanArray(size) }
        val m = Matrix(mod, fn, size)
        for (i in 0 until size) {
            m.set(6, i, i % 2 == 0)
            m.set(i, 6, i % 2 == 0)
        }
        fun finder(cx: Int, cy: Int) {
            for (dy in -4..4) for (dx in -4..4) {
                val x = cx + dx
                val y = cy + dy
                val d = maxOf(abs(dx), abs(dy))
                if (x in 0 until size && y in 0 until size) m.set(x, y, d != 2 && d != 4)
            }
        }
        finder(3, 3)
        finder(size - 4, 3)
        finder(3, size - 4)
        val align = ArrayList<Int>()
        if (ver > 1) {
            val na = ver / 7 + 2
            val step = if (ver == 32) 26 else (ver * 4 + na * 2 + 1) / (na * 2 - 2) * 2
            align.add(6)
            for (i in 0 until na - 1) align.add(1, size - 7 - i * step)
        }
        val na = align.size
        for (i in 0 until na) for (j in 0 until na) {
            if ((i == 0 && j == 0) || (i == 0 && j == na - 1) || (i == na - 1 && j == 0)) continue
            for (dy in -2..2) for (dx in -2..2) {
                m.set(align[i] + dx, align[j] + dy, maxOf(abs(dx), abs(dy)) != 1)
            }
        }
        fun formatBits(maskV: Int) {
            val data = (ecl[1] shl 3) or maskV
            var rem = data
            for (i in 0 until 10) rem = (rem shl 1) xor ((rem ushr 9) * 0x537)
            val bits = ((data shl 10) or rem) xor 0x5412
            fun b(i: Int) = (bits ushr i) and 1 != 0
            for (i in 0..5) m.set(8, i, b(i))
            m.set(8, 7, b(6))
            m.set(8, 8, b(7))
            m.set(7, 8, b(8))
            for (i in 9 until 15) m.set(14 - i, 8, b(i))
            for (i in 0 until 8) m.set(size - 1 - i, 8, b(i))
            for (i in 8 until 15) m.set(8, size - 15 + i, b(i))
            m.set(8, size - 8, true)
        }
        formatBits(0)
        if (ver >= 7) {
            var rem = ver
            for (i in 0 until 12) rem = (rem shl 1) xor ((rem ushr 11) * 0x1f25)
            val bits = ver * 4096 + rem
            for (i in 0 until 18) {
                val d = (bits shr i) and 1 == 1
                val a = size - 11 + (i % 3)
                val b = i / 3
                m.set(a, b, d)
                m.set(b, a, d)
            }
        }
        // ECC + interleave
        val nb = NUM_BLOCKS[ecl[0]][ver]
        val eccLen = ECC_PER_BLOCK[ecl[0]][ver]
        val raw = rawModules(ver) / 8
        val nShort = nb - (raw % nb)
        val shortLen = raw / nb
        val div = rsDivisor(eccLen)
        val blocks = ArrayList<List<Int>>(nb)
        var k = 0
        for (i in 0 until nb) {
            val dat = codewords.subList(k, k + shortLen - eccLen + if (i < nShort) 0 else 1).toMutableList()
            k += dat.size
            val ecc = rsRemainder(dat, div)
            if (i < nShort) dat.add(0)
            blocks.add(dat + ecc.toList())
        }
        val all = ArrayList<Int>()
        for (i in 0 until blocks[0].size) {
            blocks.forEachIndexed { j, blk ->
                if (i != shortLen - eccLen || j >= nShort) all.add(blk[i])
            }
        }
        // zigzag placement
        var bi = 0
        var right = size - 1
        while (right >= 1) {
            // JS mutates right at the timing column (right = 5): the NEXT
            // pair is (3,2), not (4,3) — column pairs shift otherwise.
            if (right == 6) right = 5
            for (vert in 0 until size) for (j in 0 until 2) {
                val x = right - j
                val up = ((right + 1) and 2) == 0
                val y = if (up) size - 1 - vert else vert
                if (!fn[y][x] && bi < all.size * 8) {
                    mod[y][x] = ((all[bi ushr 3] ushr (7 - (bi and 7))) and 1) != 0
                    bi++
                }
            }
            right -= 2
        }
        var mask = maskIn
        fun applyMask(maskV: Int) {
            for (y in 0 until size) for (x in 0 until size) {
                if (!fn[y][x] && MASKS[maskV](x, y)) mod[y][x] = !mod[y][x]
            }
        }
        if (mask < 0) {
            var best = Double.POSITIVE_INFINITY
            for (mv in 0 until 8) {
                applyMask(mv)
                formatBits(mv)
                val p = penalty(mod, size)
                if (p < best) {
                    best = p.toDouble()
                    mask = mv
                }
                applyMask(mv)
            }
        }
        applyMask(mask)
        formatBits(mask)
        return mod to mask
    }

    private fun penalty(mod: Array<BooleanArray>, size: Int): Int {
        var result = 0
        fun line(get: (Int) -> Boolean) {
            var color = false
            var run = 0
            var hist = IntArray(7)
            fun add(r: Int) {
                var rr = r
                if (hist[0] == 0) rr += size
                val next = IntArray(7)
                next[0] = rr
                System.arraycopy(hist, 0, next, 1, 6)
                hist = next
            }
            fun count(): Int {
                val n = hist[1]
                val core = n > 0 && hist[2] == n && hist[3] == n * 3 && hist[4] == n && hist[5] == n
                return (if (core && hist[0] >= n * 4 && hist[6] >= n) 1 else 0) +
                    (if (core && hist[6] >= n * 4 && hist[0] >= n) 1 else 0)
            }
            for (i in 0 until size) {
                if (get(i) == color) {
                    run++
                    if (run == 5) result += 3 else if (run > 5) result++
                } else {
                    add(run)
                    if (!color) result += count() * 40
                    color = get(i)
                    run = 1
                }
            }
            if (color) {
                add(run)
                run = 0
            }
            add(run + size)
            result += count() * 40
        }
        for (y in 0 until size) line { x -> mod[y][x] }
        for (x in 0 until size) line { y -> mod[y][x] }
        var dark = 0
        for (y in 0 until size) for (x in 0 until size) {
            if (mod[y][x]) dark++
            if (x < size - 1 && y < size - 1) {
                val c = mod[y][x]
                if (c == mod[y][x + 1] && c == mod[y + 1][x] && c == mod[y + 1][x + 1]) result += 3
            }
        }
        val total = size * size
        result += (ceil(abs(dark * 20.0 - total * 10.0) / total).toInt() - 1) * 10
        return result
    }

    /**
     * Web encodeQr defaults: Ecc.MEDIUM, boosted when free, optimal
     * segmentation, automatic mask. Throws when the data exceeds a v40 symbol.
     */
    fun encode(text: String, optimal: Boolean = true, mask: Int = -1, boostEcl: Boolean = true): Qr {
        var ecl = ECC_MEDIUM
        var ver = 0
        var segs: List<Seg> = emptyList()
        var used = 0.0
        val cache = HashMap<Int, List<Seg>>()
        for (v in 1..40) {
            val group = if (v <= 9) 9 else if (v <= 26) 26 else 40
            val cached = cache.getOrPut(group) {
                if (optimal) makeSegmentsForVersion(text, group) else makeSegmentsSimple(text)
            }
            if (totalBits(cached, v) <= dataCodewords(v, ecl) * 8) {
                ver = v
                segs = cached
                used = totalBits(cached, v)
                break
            }
            if (v == 40) throw IllegalArgumentException("Data too long for a QR code")
        }
        if (boostEcl) {
            for (e in listOf(ECC_MEDIUM, ECC_QUARTILE, ECC_HIGH)) {
                if (used <= dataCodewords(ver, e) * 8) ecl = e
            }
        }
        val bits = ArrayList<Int>()
        for (s in segs) {
            push(bits, MODE_BITS[s.mode], 4)
            push(bits, s.numChars, ccBits(s.mode, ver))
            bits.addAll(s.data)
        }
        val cap = dataCodewords(ver, ecl) * 8
        push(bits, 0, minOf(4, cap - bits.size))
        push(bits, 0, (8 - (bits.size % 8)) % 8)
        var pad = 0xec
        while (bits.size < cap) {
            push(bits, pad, 8)
            pad = pad xor 0xec xor 0x11
        }
        val cw = ArrayList<Int>(bits.size / 8)
        var i = 0
        while (i < bits.size) {
            var b = 0
            for (j in 0 until 8) b = (b shl 1) or bits[i + j]
            cw.add(b)
            i += 8
        }
        val (mod, maskOut) = buildMatrix(ver, ecl, cw, mask)
        return Qr(ver, ver * 4 + 17, mod)
    }
}
