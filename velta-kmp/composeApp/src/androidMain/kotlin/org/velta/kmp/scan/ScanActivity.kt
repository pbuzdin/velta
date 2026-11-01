package org.velta.kmp.scan

import android.Manifest
import android.content.pm.PackageManager
import android.os.Bundle
import android.util.Log
import androidx.activity.ComponentActivity
import androidx.activity.result.contract.ActivityResultContracts
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageProxy
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.core.content.ContextCompat
import com.google.zxing.BinaryBitmap
import com.google.zxing.DecodeHintType
import com.google.zxing.common.HybridBinarizer
import com.google.zxing.qrcode.QRCodeReader
import java.util.concurrent.Executors

/**
 * Invite-QR scanner (P4): CameraX preview + a ZXing QRCodeReader over the
 * luma plane. Decodes locally — nothing leaves the device. First successful
 * decode finishes with the payload as the activity result.
 */
class ScanActivity : ComponentActivity() {

    private val analysisExecutor = Executors.newSingleThreadExecutor()
    private var delivered = false
    private lateinit var previewView: PreviewView

    private val requestCamera = registerForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { granted ->
        if (granted) startCamera() else finish()
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        previewView = PreviewView(this)
        setContentView(previewView)

        if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) ==
            PackageManager.PERMISSION_GRANTED
        ) {
            startCamera()
        } else {
            requestCamera.launch(Manifest.permission.CAMERA)
        }
    }

    private fun startCamera() {
        val future = ProcessCameraProvider.getInstance(this)
        future.addListener({
            try {
                val provider = future.get()
                val cameraPreview = Preview.Builder().build().also {
                    it.setSurfaceProvider(previewView.surfaceProvider)
                }
                val analysis = ImageAnalysis.Builder()
                    .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                    .build()
                analysis.setAnalyzer(analysisExecutor, ::analyze)
                provider.unbindAll()
                provider.bindToLifecycle(
                    this,
                    CameraSelector.DEFAULT_BACK_CAMERA,
                    cameraPreview,
                    analysis,
                )
            } catch (t: Throwable) {
                Log.e(TAG, "camera start failed", t)
                finish()
            }
        }, ContextCompat.getMainExecutor(this))
    }

    private fun analyze(frame: ImageProxy) {
        if (delivered) {
            frame.close()
            return
        }
        val text = try {
            val plane = frame.planes[0]
            val bytes = ByteArray(plane.buffer.remaining())
            plane.buffer.get(bytes)
            val source = com.google.zxing.PlanarYUVLuminanceSource(
                bytes, plane.rowStride, frame.height, 0, 0, frame.width, frame.height, false,
            )
            QRCodeReader().decode(
                BinaryBitmap(HybridBinarizer(source)),
                mapOf(DecodeHintType.TRY_HARDER to true),
            ).text
        } catch (e: com.google.zxing.NotFoundException) {
            null // no QR in this frame — normal
        } catch (t: Throwable) {
            Log.w(TAG, "analyze failed", t)
            null
        } finally {
            frame.close()
        }
        if (text != null && !delivered) {
            delivered = true
            // The model is a process-wide singleton: hand the payload straight
            // over and finish — the Join screen picks it up when resumed.
            runOnUiThread {
                org.velta.kmp.AppHolder.obtain(applicationContext).onQrScanned(text)
                finish()
            }
        }
    }

    override fun onDestroy() {
        analysisExecutor.shutdown()
        super.onDestroy()
    }

    companion object {
        private const val TAG = "velta-scan"
        const val EXTRA_TEXT = "org.velta.kmp.scan.TEXT"
    }
}
