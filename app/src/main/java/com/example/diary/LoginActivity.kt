package com.example.diary

import android.content.Context
import android.content.Intent
import android.content.SharedPreferences
import android.os.Build
import android.os.Bundle
import android.widget.Button
import android.widget.EditText
import android.widget.TextView
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.annotation.RequiresApi

class LoginActivity : ComponentActivity() {
    private lateinit var prefs: SharedPreferences
    private val maxUsers = 3

    @RequiresApi(Build.VERSION_CODES.TIRAMISU)
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_login)

        prefs = getSharedPreferences("diary_users", Context.MODE_PRIVATE)
        val btnLogin = findViewById<Button>(R.id.btn_login)
        val btnRegister = findViewById<Button>(R.id.btn_register)
        val tvToggle = findViewById<TextView>(R.id.tv_toggle)
        val usernameInput = findViewById<EditText>(R.id.input_username)
        val passwordInput = findViewById<EditText>(R.id.input_password)

        var isLoginMode = true
        updateUiMode(isLoginMode)

        tvToggle.setOnClickListener {
            isLoginMode = !isLoginMode
            updateUiMode(isLoginMode)
        }

        btnLogin.setOnClickListener {
            val user = usernameInput.text.toString().trim()
            val pass = passwordInput.text.toString().trim()
            if (authenticate(user, pass)) {
                // Guardar usuario activo
                prefs.edit().putString("active_user", user).apply()
                startMain()
            } else {
                Toast.makeText(this, "Credenciales incorrectas", Toast.LENGTH_SHORT).show()
            }
        }

        btnRegister.setOnClickListener {
            val user = usernameInput.text.toString().trim()
            val pass = passwordInput.text.toString().trim()
            if (prefs.getAll().size >= maxUsers) {
                Toast.makeText(this, "Se alcanzó el número máximo de usuarios (3)", Toast.LENGTH_SHORT).show()
                return@setOnClickListener
            }
            if (prefs.contains(user)) {
                Toast.makeText(this, "El usuario ya existe", Toast.LENGTH_SHORT).show()
                return@setOnClickListener
            }
            prefs.edit().putString(user, pass).apply()
            Toast.makeText(this, "Usuario registrado. Inicia sesión.", Toast.LENGTH_SHORT).show()
            isLoginMode = true
            updateUiMode(isLoginMode)
        }
    }

    private fun authenticate(user: String, pass: String): Boolean {
        val storedPass = prefs.getString(user, null)
        return storedPass != null && storedPass == pass
    }

    private fun startMain() {
        val intent = Intent(this, MainActivity::class.java)
        startActivity(intent)
        finish()
    }

    private fun updateUiMode(isLogin: Boolean) {
        val btnLogin = findViewById<Button>(R.id.btn_login)
        val btnRegister = findViewById<Button>(R.id.btn_register)
        val tvToggle = findViewById<TextView>(R.id.tv_toggle)
        if (isLogin) {
            btnLogin.visibility = android.view.View.VISIBLE
            btnRegister.visibility = android.view.View.GONE
            tvToggle.text = "¿No tienes cuenta? Regístrate"
        } else {
            btnLogin.visibility = android.view.View.GONE
            btnRegister.visibility = android.view.View.VISIBLE
            tvToggle.text = "¿Ya tienes cuenta? Inicia sesión"
        }
    }
}
