from django import forms
from django.contrib.auth.forms import UserCreationForm
from .models import User


class StudentRegisterForm(UserCreationForm):
    """升级版：自带严格数据校验的学生注册表单"""

    class Meta(UserCreationForm.Meta):
        model = User
        # 前端展示的表单字段顺序
        fields = ('username', 'student_id', 'dorm_building', 'phone')

        # 给所有输入框套上漂亮的 Bootstrap 5 样式
        widgets = {
            'username': forms.TextInput(attrs={'class': 'form-control', 'placeholder': '起一个心仪的同学昵称'}),
            'student_id': forms.TextInput(attrs={'class': 'form-control', 'placeholder': '请输入真实的学号'}),
            'dorm_building': forms.TextInput(attrs={'class': 'form-control', 'placeholder': '例如：西区15栋-302'}),
            'phone': forms.TextInput(attrs={'class': 'form-control', 'placeholder': '请输入11位手机号'}),
        }

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        # 汉化表单自带的提示标签
        self.fields['username'].label = "同学昵称"
        self.fields['student_id'].label = "真实学号"
        self.fields['dorm_building'].label = "宿舍楼栋"
        self.fields['phone'].label = "联系电话"

    # 💡 完善校验 1：校验学号
    def clean_student_id(self):
        student_id = self.cleaned_data.get('student_id')
        if not student_id.isdigit():
            raise forms.ValidationError("学号格式不正确，必须全部为数字！")

        # 检查学号是否已被别的同学注册过
        if User.objects.filter(student_id=student_id).exists():
            raise forms.ValidationError("该学号已被注册！如有疑问请联系管理员。")
        return student_id

    # 💡 完善校验 2：校验手机号
    def clean_phone(self):
        phone = self.cleaned_data.get('phone')
        if len(phone) != 11 or not phone.isdigit() or not phone.startswith('1'):
            raise forms.ValidationError("请输入合规的 11 位中国大陆手机号！")
        return phone