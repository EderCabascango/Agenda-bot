package com.example.diary

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp

data class ActivityItem(val time: String, val title: String, var done: Boolean = false)

class MainActivity : ComponentActivity() {
    private val sampleActivities = listOf(
        ActivityItem("08:00", "Desayuno"),
        ActivityItem("09:30", "Reunión"),
        ActivityItem("11:00", "Trabajo en proyecto"),
        ActivityItem("13:00", "Almuerzo")
    )

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            DiaryAppTheme {
                Surface(
                    modifier = Modifier.fillMaxSize(),
                    color = MaterialTheme.colorScheme.background
                ) {
                    DiaryScreen()
                }
            }
        }
    }

    @Composable
    fun DiaryScreen() {
        var activities by remember { mutableStateOf(sampleActivities) }
        Scaffold(
            topBar = {
                SmallTopAppBar(
                    title = { Text("Mi Diario") },
                    actions = {
                        IconButton(onClick = { /* Settings */ }) {
                            Icon(Icons.Default.Settings, contentDescription = "Settings")
                        }
                    }
                )
            },
            floatingActionButton = {
                FloatingActionButton(onClick = { /* Add activity */ }) {
                    Icon(Icons.Default.Add, contentDescription = "Add")
                }
            }
        ) { padding ->
            LazyColumn(
                contentPadding = padding,
                verticalArrangement = Arrangement.spacedBy(8.dp),
                modifier = Modifier.padding(16.dp)
            ) {
                items(activities) { item ->
                    ActivityRow(item) { updated ->
                        activities = activities.map { if (it.time == updated.time) updated else it }
                    }
                }
            }
        }
    }

    @Composable
    fun ActivityRow(item: ActivityItem, onToggle: (ActivityItem) -> Unit) {
        Row(
            verticalAlignment = androidx.compose.ui.Alignment.CenterVertically,
            modifier = Modifier.fillMaxWidth()
        ) {
            Checkbox(
                checked = item.done,
                onCheckedChange = { onToggle(item.copy(done = it)) }
            )
            Spacer(modifier = Modifier.width(8.dp))
            Column {
                Text(text = item.time, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.Bold)
                Text(text = item.title, style = MaterialTheme.typography.bodyMedium)
            }
        }
    }
}
