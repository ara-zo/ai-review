package com.example.aireview

import java.time.LocalDateTime

data class User(
    val id: Long,
    val name: String,
    val email: String,
    val createdAt: LocalDateTime = LocalDateTime.now()
)