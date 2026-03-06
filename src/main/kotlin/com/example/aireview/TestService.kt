package com.example.aireview

import org.slf4j.LoggerFactory

class TestService {

    private val logger = LoggerFactory.getLogger(TestService::class.java)

    fun getUserList(): List<User> {
        val list = mutableListOf<User>()
        try {
            mutableListOf<User>()
        } catch (e: Exception) {
            // 로깅 처리
            logger.error("Failed to get user list", e)
        }
        return list
    }
}