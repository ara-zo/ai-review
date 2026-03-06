package com.example.aireview.core.user.service

import com.example.aireview.infrastructure.coredb.entity.User
import org.slf4j.LoggerFactory
import org.springframework.stereotype.Service
import kotlin.jvm.java

@Service
class UserService {

    private val logger = LoggerFactory.getLogger(UserService::class.java)

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