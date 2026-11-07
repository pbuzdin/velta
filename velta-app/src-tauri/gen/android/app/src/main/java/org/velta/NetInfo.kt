package org.velta

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.Build
import android.telephony.TelephonyManager
import org.json.JSONArray
import org.json.JSONObject
import java.net.Inet6Address

// Optional DNS tunnel (tunnel.rs): the resolvers the operator handed this
// network and the SIM's operator code. On allowlist-only mobile internet the
// operator-assigned resolver is the one that always answers, so the tunnel
// puts it first. Needs ACCESS_NETWORK_STATE only (already declared).
object NetInfo {
    @JvmStatic
    fun snapshot(context: Context): String {
        val out = JSONObject()
        val dns = JSONArray()
        try {
            val cm = context.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
            val net = cm.activeNetwork
            val lp = net?.let { cm.getLinkProperties(it) }
            lp?.dnsServers?.forEach { addr ->
                // Link-local IPv6 needs a scope id the tunnel can't use.
                if (addr.isLoopbackAddress || addr.isLinkLocalAddress) return@forEach
                val host = addr.hostAddress?.substringBefore('%') ?: return@forEach
                dns.put(if (addr is Inet6Address) "[$host]:53" else "$host:53")
            }
            if (lp != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                out.put("private_dns", lp.isPrivateDnsActive)
                lp.privateDnsServerName?.let { out.put("private_dns_name", it) }
            }
            val caps = net?.let { cm.getNetworkCapabilities(it) }
            out.put("transport", when {
                caps == null -> "none"
                caps.hasTransport(NetworkCapabilities.TRANSPORT_VPN) -> "vpn"
                caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) -> "cellular"
                caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) -> "wifi"
                caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) -> "ethernet"
                else -> "other"
            })
        } catch (e: Exception) {
            out.put("error", e.toString())
        }
        out.put("dns", dns)
        try {
            val tm = context.getSystemService(Context.TELEPHONY_SERVICE) as TelephonyManager
            // MCC+MNC of the SIM, e.g. 25001. No permission needed.
            out.put("sim_operator", tm.simOperator ?: "")
            out.put("network_operator", tm.networkOperator ?: "")
            out.put("operator_name", tm.networkOperatorName ?: "")
        } catch (e: Exception) {
            out.put("telephony_error", e.toString())
        }
        return out.toString()
    }

    // #302: data-roaming state for the Text-only mode hint (app-side prompt).
    // Needs no permission.
    @JvmStatic
    fun isRoaming(context: Context): Boolean {
        return try {
            val tm = context.getSystemService(Context.TELEPHONY_SERVICE) as? TelephonyManager
            tm?.isNetworkRoaming ?: false
        } catch (e: Exception) {
            false
        }
    }
}
