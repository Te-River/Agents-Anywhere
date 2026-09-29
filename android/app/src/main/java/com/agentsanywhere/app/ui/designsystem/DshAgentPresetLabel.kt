package com.agentsanywhere.app.ui.designsystem

import androidx.compose.runtime.Composable
import androidx.compose.ui.res.stringResource
import com.agentsanywhere.app.R

@Composable
fun dshAgentPresetLabel(id: String, label: String = id): String {
    if (!label.equals(id, ignoreCase = true)) return label
    return when (id) {
        "standard" -> stringResource(R.string.dsh_agent_preset_standard)
        "ptc" -> stringResource(R.string.dsh_agent_preset_ptc)
        "minimal" -> stringResource(R.string.dsh_agent_preset_minimal)
        "cordis" -> stringResource(R.string.dsh_agent_preset_cordis)
        else -> label
    }
}
