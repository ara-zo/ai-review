package com.example.aireview

class TestService {
    class TestService {
        fun Get_User_List() : List<Any> {  // 네이밍 컨벤션 위반
            val list = ArrayList<Any>()
            try {
                // something
            } catch (e: Exception) {
                // 빈 catch 블록
            }
            return list
        }
    }
}